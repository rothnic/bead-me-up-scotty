import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  beadSchema,
  unwrapEnvelope,
  type Bead,
  type CreateInput,
  type UpdateInput,
  type DepType,
} from "./schema";
import type { BeadsStore, DoctorInfo } from "./store";
import type { StorePolicy, StoreSource } from "./source";

const pExecFile = promisify(execFile);
const BD_BIN = process.env.BD_BIN || "bd";
const GC_BIN = process.env.SCOTTY_GC_BIN || "gc";

interface BdBinding {
  repoPath: string;
  nativeProjectId: string;
  database: string;
  city?: string;
  rig?: string;
  source?: StoreSource;
}

interface BdCommand {
  bin: string;
  prefix: string[];
  route: NonNullable<StoreSource["route"]>;
  repositoryRoot?: string;
  storeRoot?: string;
}

const directBd = (): BdCommand => ({ bin: BD_BIN, prefix: [], route: { kind: "direct", endpoint: null } });

function nativeEnv(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "BEADS_DIR" || key === "BEADS_DB" || key === "BEADS_DATABASE" || key.startsWith("GC_")) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function assertIssueId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new BdError("Invalid native bd issue id", "invalid_input");
  }
}

export class BdError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "BdError";
    this.code = code;
  }
}

/**
 * Run a bd command. Args are passed as an array (no shell) so titles and
 * descriptions are injection-safe. Always requests the JSON envelope.
 */
async function runBdRaw(
  args: string[],
  opts: { repoPath: string; actor?: string; readonly?: boolean; binding?: BdBinding; input?: string },
): Promise<string> {
  try {
    // Verify managed reads as well as writes. UUIDs can match on an alternate
    // endpoint; the native city/rig route, not cwd's stale port, owns authority.
    const command = opts.binding ? await verifyBdBinding(opts.binding) : directBd();
    const commandArgs = [
      ...command.prefix,
      ...(opts.readonly ? ["--readonly"] : []),
      ...(opts.actor && command.route.kind === "direct" ? ["--actor", opts.actor] : []),
      ...args,
    ];
    const execution = pExecFile(command.bin, commandArgs, {
      cwd: opts.repoPath,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000,
      env: {
        ...nativeEnv(),
        BD_JSON_ENVELOPE: "1",
        ...(opts.actor ? { BEADS_ACTOR: opts.actor } : {}),
      },
    });
    let inputError: Error | undefined;
    if (opts.input !== undefined) {
      // gc scans scope flags even after `--`; keep prose out of argv entirely.
      execution.child.stdin?.on("error", (error: Error) => { inputError = error; });
      execution.child.stdin?.end(opts.input);
    }
    const { stdout } = await execution;
    if (inputError) throw new BdError("Native bd input transport failed", "input_transport");
    return stdout;
  } catch (err: unknown) {
    if (err instanceof BdError) throw err;
    const e = err as { stderr?: string; message?: string };
    // bd emits a JSON error object to stderr with a `code` when --json is active.
    const stderr = (e.stderr || "").trim();
    try {
      const parsed = JSON.parse(stderr) as { error?: string; code?: string };
      if (parsed.error) throw new BdError(parsed.error, parsed.code);
    } catch (parseErr) {
      if (parseErr instanceof BdError) throw parseErr;
    }
    // bd emits the pending-migration block as PLAIN-TEXT stderr, not the JSON
    // envelope, so it would otherwise fall through uncoded and dump ~200 words
    // of raw text into a toast. Tag it here so the UI keys off a stable code
    // rather than string-matching in React. (gastownhall/beads#4259)
    if (/pending schema migration|BD_ALLOW_REMOTE_MIGRATE|#4259/i.test(stderr)) {
      throw new BdError(stderr, "schema_migration_required");
    }
    throw new BdError(stderr || e.message || "bd command failed");
  }
}

async function runBdJson<T = unknown>(
  args: string[],
  opts: { repoPath: string; actor?: string; readonly?: boolean; binding?: BdBinding },
): Promise<T> {
  const out = await runBdRaw([...args, "--json"], opts);
  return unwrapEnvelope(JSON.parse(out)) as T;
}

/** Parse `bd export --json` JSONL output into validated beads. */
function parseExport(jsonl: string): Bead[] {
  const beads: Bead[] = [];
  for (const [lineNumber, line] of jsonl.split("\n").entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new BdError(`bd export returned invalid JSON on line ${lineNumber + 1}`, "parse_error");
    }
    if (obj && typeof obj === "object" && "_type" in obj && (obj as { _type?: unknown })._type !== "issue") {
      // bd can export explicit non-issue records (for example memories). They
      // are not beads and are safe to omit; malformed issue records are not.
      continue;
    }
    const parsed = beadSchema.safeParse(obj);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new BdError(`bd export returned malformed issue on line ${lineNumber + 1}: ${detail}`, "parse_error");
    }
    beads.push(parsed.data);
  }
  return beads;
}

function parseComments(raw: unknown, id: string): Bead["comments"] {
  if (!Array.isArray(raw)) throw new BdError(`bd comments ${id} returned a non-array`, "parse_error");
  return raw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new BdError(`bd comments ${id} returned malformed comment ${index}`, "parse_error");
    }
    const comment = item as Record<string, unknown>;
    if (comment.issue_id !== id || typeof comment.text !== "string" || !comment.text || typeof comment.author !== "string" || !comment.author) {
      throw new BdError(`bd comments ${id} returned an invalid comment ${index}`, "parse_error");
    }
    return {
      ...(typeof comment.id === "string" ? { id: comment.id } : {}),
      issue_id: id,
      author: comment.author,
      text: comment.text,
      ...(typeof comment.created_at === "string" ? { created_at: comment.created_at } : {}),
    };
  });
}

// ---- bd serialization (embedded Dolt is single-writer *per database*) ----
// EVERY bd invocation — including read-only `export`/`show` — rewrites the
// embedded-Dolt store, so reads MUST serialize with writes too. Running them
// concurrently corrupts persists ("Unable to write SST file …") and collides on
// compaction ("Another write batch or compaction is already active").
// Keyed by repoPath so same-project bd calls serialize while different projects
// run in parallel.
const writeChains = new Map<string, Promise<unknown>>();
function serializeWrite<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(repoPath) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeChains.set(
    repoPath,
    next.catch(() => {}),
  );
  return next;
}

async function repositoryRoot(root: string): Promise<string> {
  try {
    const env = nativeEnv();
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    const { stdout } = await pExecFile("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, timeout: 5000, env });
    // Git lists the main checkout first. NUL records preserve unusual paths.
    const worktrees = stdout.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    if (!worktrees.length || !worktrees.some((entry) => {
      try { return fs.realpathSync(entry) === root; } catch { return false; }
    })) throw new Error("unbound worktree");
    return fs.realpathSync(worktrees[0]);
  } catch {
    throw new BdError("Native source repository identity is unavailable", "source_binding");
  }
}

/** Let native discovery identify registered rigs; never parse city/port files. */
async function resolveBdCommand(binding: BdBinding, root: string): Promise<BdCommand> {
  if (binding.rig && !binding.city) throw new BdError("A declared rig route requires its city", "source_binding");
  const repoRoot = await repositoryRoot(root);
  const direct = () => ({ ...directBd(), repositoryRoot: repoRoot, storeRoot: root });
  let value: Record<string, unknown>;
  try {
    const { stdout } = await pExecFile(GC_BIN, [
      ...(binding.city ? ["--city", binding.city] : []), "rig", "list", "--json",
    ], { cwd: repoRoot, timeout: 5000, env: nativeEnv() });
    value = JSON.parse(stdout);
  } catch (error) {
    // Only the native, structured no-city result permits ordinary bd routing.
    // Unavailable gc, bad config, timeouts and explicit route failures stay closed.
    const failed = error as { stdout?: string };
    try {
      const result = JSON.parse(failed.stdout || "");
      if (!binding.city && !binding.rig && result.ok === false &&
          result.error?.code === "city_resolve_failed" &&
          result.error?.message === "gc rig list: not in a city directory (no city.toml or .gc/ found)") {
        return direct();
      }
    } catch { /* An unstructured discovery failure is not a direct-project result. */ }
    throw new BdError("Native project route discovery failed", "source_binding");
  }
  if (value?.ok !== true || value.schema_version !== "1" || typeof value.city_path !== "string" ||
      !path.isAbsolute(value.city_path) || !Array.isArray(value.rigs) || !value.rigs.length ||
      (value.summary as { total?: unknown } | undefined)?.total !== value.rigs.length ||
      value.rigs.some((rig) => !rig || typeof rig.name !== "string" || !rig.name.trim() ||
        typeof rig.path !== "string" || (rig.path !== "" && !path.isAbsolute(rig.path)) || typeof rig.hq !== "boolean") ||
      new Set(value.rigs.map((rig) => rig.name)).size !== value.rigs.length ||
      value.rigs.filter((rig) => rig.hq).length !== 1) {
    throw new BdError("Native project route discovery returned an invalid registry", "source_binding");
  }
  let city: string;
  const matches: { name: string; path: string; hq: boolean }[] = [];
  try {
    city = fs.realpathSync(value.city_path);
    for (const rig of value.rigs) {
      if (!rig.path && !rig.hq) continue; // Native unbound rigs have an empty path.
      let rigRoot: string;
      try { rigRoot = fs.realpathSync(rig.path); } catch {
        if (rig.hq || rig.name === binding.rig || rig.path === root || rig.path === repoRoot) throw new Error("bound root unavailable");
        continue; // An unrelated offline rig must not disable a healthy store.
      }
      if (rig.hq && rigRoot !== city) throw new Error("invalid city root");
      if (rigRoot === root || rigRoot === repoRoot) matches.push({ ...rig, path: rigRoot });
    }
  } catch {
    throw new BdError("Native project route roots are unavailable or invalid", "source_binding");
  }
  if (!matches.length && !binding.city && !binding.rig) return direct();
  if (matches.length !== 1 || (binding.rig && matches[0].name !== binding.rig)) {
    throw new BdError("Native project route does not uniquely bind the configured root", "source_binding");
  }
  const rig = matches[0];
  return {
    bin: GC_BIN,
    // gc pins the native store environment; bd's directory flag preserves the
    // exact caller worktree even though gc starts its subprocess in the rig.
    prefix: ["--city", city, "bd", ...(rig.hq ? [] : ["--rig", rig.name]), "--directory", root],
    route: { kind: rig.hq === true ? "city" : "rig", city, ...(rig.hq === true ? {} : { rig: rig.name }), endpoint: null },
    repositoryRoot: repoRoot,
    storeRoot: rig.path,
  };
}

async function bdContext(repoPath: string, command: BdCommand): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await pExecFile(command.bin, [...command.prefix, "--readonly", "context", "--json"], {
      cwd: repoPath,
      timeout: 5000,
      env: nativeEnv({ BD_JSON_ENVELOPE: "1" }),
    });
    const value = unwrapEnvelope(JSON.parse(stdout)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context was not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new BdError(`bd context verification failed: ${(error as Error).message}`, "source_binding");
  }
}

async function verifyBdBinding(binding: BdBinding): Promise<BdCommand> {
  let root: string;
  let beadsDir: string;
  try {
    root = fs.realpathSync(binding.repoPath);
  } catch (error) {
    throw new BdError(`bd source root is unavailable: ${(error as Error).message}`, "source_binding");
  }
  const command = await resolveBdCommand(binding, root);
  try { beadsDir = fs.realpathSync(path.join(command.storeRoot ?? root, ".beads")); } catch {
    throw new BdError("Native source Beads directory is unavailable", "source_binding");
  }
  const context = await bdContext(root, command);
  // `repo_root` names the shared checkout root in a Git worktree, while
  // `cwd_repo_root` identifies the exact worktree supplied to this store. The
  // latter is the binding boundary; the native project, database, and beads
  // directory checks below still prevent selecting a different source.
  const mismatches = [
    context.cwd_repo_root !== root ? `cwd_repo_root=${String(context.cwd_repo_root)}` : "",
    context.repo_root !== command.repositoryRoot ? `repo_root=${String(context.repo_root)}` : "",
    context.beads_dir !== beadsDir ? `beads_dir=${String(context.beads_dir)}` : "",
    context.project_id !== binding.nativeProjectId ? `project_id=${String(context.project_id)}` : "",
    context.database !== binding.database ? `database=${String(context.database)}` : "",
  ].filter(Boolean);
  if (mismatches.length) {
    throw new BdError(
      `bd source binding mismatch for ${root}; expected project ${binding.nativeProjectId}/${binding.database}, observed ${mismatches.join(", ")}`,
      "source_binding",
    );
  }
  if (context.backend !== "dolt") throw new BdError("Native bd backend is not Dolt", "source_binding");
  if (context.dolt_mode === "server") {
    const host = context.server_host;
    const port = context.server_port;
    if (typeof host !== "string" || !host || /\s/.test(host) ||
        typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BdError("Native bd server endpoint is missing or invalid", "source_binding");
    }
    command.route.endpoint = { host, port };
  } else if (context.dolt_mode !== "embedded" || command.route.kind !== "direct") {
    throw new BdError("Native bd authority mode is unqualified", "source_binding");
  }
  if (binding.source) binding.source.route = command.route;
  return command;
}

export async function isBdAvailable(repoPath: string, policy: StorePolicy = {}): Promise<boolean> {
  if (policy.managed) {
    if (!policy.nativeProjectId || !policy.database) return false;
    await verifyBdBinding({ repoPath, nativeProjectId: policy.nativeProjectId, database: policy.database, city: policy.city, rig: policy.rig });
  }
  try {
    await pExecFile(BD_BIN, ["--version"], { cwd: repoPath, timeout: 5000, env: nativeEnv() });
    return policy.managed === true || fs.existsSync(path.join(repoPath, ".beads"));
  } catch {
    return false;
  }
}

export function createBdStore(repoPath: string, policy: StorePolicy = {}): BeadsStore {
  const managed = policy.managed === true;
  if (managed && (!policy.nativeProjectId || !policy.database)) {
    throw new BdError("Managed bd sources require their native project and database", "source_binding");
  }
  const readOnly = policy.readOnly === true;
  const capabilities = policy.capabilities ?? { comments: true, priority: true };
  const source: StoreSource = {
    kind: "bd",
    managed,
    label: policy.label ?? `bd at ${repoPath}`,
    scope: policy.scope ?? "local bd project",
    root: repoPath,
    cli: null,
    nativeProjectId: policy.nativeProjectId ?? null,
    database: policy.database ?? null,
    readOnly,
    capabilities,
    readAt: null,
    newestRecordUpdatedAt: null,
  };
  const binding = managed && policy.nativeProjectId && policy.database
    ? { repoPath, nativeProjectId: policy.nativeProjectId, database: policy.database, city: policy.city, rig: policy.rig, source }
    : undefined;
  // Managed reads are always native read-only, even when comments/priority
  // writers are enabled for the selected source.
  const ro = { repoPath, readonly: managed || readOnly, binding };
  const assertWritable = (capability?: "comments" | "priority") => {
    if (readOnly) throw new BdError("This native bd project is read-only in Scotty", "read_only");
    if (managed && (!capability || !capabilities[capability])) {
      throw new BdError(
        capability ? `The bd backend does not allow ${capability}` : "This native bd operation is unavailable in Scotty",
        "capability_unavailable",
      );
    }
  };
  const rw = (actor: string, capability?: "comments" | "priority") => {
    assertWritable(capability);
    return { repoPath, actor, binding };
  };
  // Collapse concurrent list() callers (the polling views) onto one in-flight export.
  let inflightList: Promise<Bead[]> | null = null;

  async function show(id: string): Promise<Bead> {
    assertIssueId(id);
    // bd 1.0.5 `show <id> --json` returns its envelope `data` as an ARRAY even
    // for a single id, while beadSchema expects one object. Unwrap before parse.
    const data = await runBdJson(["show", id], ro);
    const rec = Array.isArray(data) ? data[0] : data;
    if (!rec) throw new BdError(`bead ${id} not found`, "not_found");
    const parsed = beadSchema.safeParse(rec);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new BdError(`could not parse bead ${id}: ${detail}`, "parse_error");
    }
    if (parsed.data.id !== id) {
      throw new BdError(`bd show ${id} returned ${parsed.data.id}`, "parse_error");
    }
    const comments = parseComments(await runBdJson(["comments", id], ro), id);
    return { ...parsed.data, comments };
  }

  function recordSource(beads: Bead[]): void {
    source.readAt = new Date().toISOString();
    source.recordCount = beads.length;
    source.edgeCount = beads.reduce((count, bead) => count + (bead.dependencies?.length ?? 0), 0);
    source.statusCounts = beads.reduce<Record<string, number>>((counts, bead) => {
      counts[bead.status] = (counts[bead.status] ?? 0) + 1;
      return counts;
    }, {});
    source.newestRecordUpdatedAt = beads
      .map((bead) => bead.updated_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
  }

  return {
    kind: "bd",
    source,

    async list() {
      // Dedupe concurrent callers onto one in-flight export, and serialize that
      // export with all other bd ops so reads can't collide with writes/compaction.
      if (inflightList) return inflightList;
      inflightList = serializeWrite(repoPath, async () => {
        const beads = parseExport(await runBdRaw(["export", "--json"], ro));
        recordSource(beads);
        return beads;
      });
      try {
        return await inflightList;
      } finally {
        inflightList = null;
      }
    },

    async get(id) {
      // Serialized too — `bd show` rewrites the store like any other invocation.
      return serializeWrite(repoPath, async () => {
        try {
          return await show(id);
        } catch (e) {
          if (e instanceof BdError && e.code === "not_found") return null;
          throw e;
        }
      });
    },

    create(input: CreateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        const args = [
          "create",
          input.title,
          "-t",
          input.issue_type,
          "--priority",
          String(input.priority),
        ];
        if (input.description) args.push("--description", input.description);
        if (input.assignee) args.push("--assignee", input.assignee);
        if (input.labels?.length) args.push("-l", input.labels.join(","));
        if (input.parent) args.push("--parent", input.parent);
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        const id = created.id;
        if (input.backlog) {
          await runBdRaw(["update", id, "-s", "deferred"], rw(actor));
        }
        return show(id);
      });
    },

    update(id, patch: UpdateInput, actor: string) {
      return serializeWrite(repoPath, async () => {
        assertIssueId(id);
        // Resolve the full native id before any write. `bd` accepts prefixes;
        // a preflight show makes an abbreviated/ambiguous request fail closed
        // instead of allowing the writer to target another bead. Keep the
        // post-write show below as the readback/field verification.
        const before = await show(id);
        if (managed) {
          const keys = Object.keys(patch);
          if (keys.length !== 1 || keys[0] !== "priority") {
            throw new BdError("Managed bd updates allow only priority", "capability_unavailable");
          }
        }
        const args = ["update", id];
        if (patch.title !== undefined) args.push("--title", patch.title);
        if (patch.description !== undefined) args.push("--description", patch.description);
        if (patch.status !== undefined) args.push("-s", patch.status);
        if (patch.priority !== undefined) args.push("--priority", String(patch.priority));
        if (patch.issue_type !== undefined) args.push("-t", patch.issue_type);
        if (patch.assignee !== undefined) args.push("--assignee", patch.assignee);
        // `!== undefined` rather than a truthiness check: `""` is the detach
        // signal, so `if (patch.parent)` would make detaching inexpressible.
        if (patch.parent !== undefined) args.push("--parent", patch.parent);
        // Labels are replace-all. `bd update --set-labels ""` is silently
        // dropped (verified against bd 1.1.0) — an empty value never clears —
        // so the "remove every label" case has to go through --remove-label
        // with the bead's current labels instead.
        if (patch.labels !== undefined) {
          if (patch.labels.length) {
            args.push("--set-labels", patch.labels.join(","));
          } else {
            const current = before.labels ?? [];
            if (current.length) args.push("--remove-label", current.join(","));
          }
        }
        // `bd update <id>` with no field flags is a no-op error; skip the call
        // when clearing labels on a bead that had none.
        if (args.length > 2) await runBdRaw(args, rw(actor, managed ? "priority" : undefined));
        return show(id);
      });
    },

    setStatus(id, status, actor, reason) {
      return serializeWrite(repoPath, async () => {
        if (status === "closed") {
          const args = ["close", id];
          // Only `bd close --reason` persists a close reason, and re-closing an
          // already-closed bead won't overwrite it — so this is the one chance
          // to record why. Args go through execFile, so prose is safe verbatim.
          const trimmed = reason?.trim();
          if (trimmed) args.push("--reason", trimmed);
          await runBdRaw(args, rw(actor));
        } else {
          await runBdRaw(["update", id, "-s", status], rw(actor));
        }
        return show(id);
      });
    },

    remove(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["delete", id, "--force"], rw(actor));
      });
    },

    addComment(id, text, actor) {
      return serializeWrite(repoPath, async () => {
        assertIssueId(id);
        // `bd comment` accepts prefixes, so bind the request to the exact
        // native issue before invoking the writer. The post-write show below
        // remains the actor/text readback proof.
        await show(id);
        // Native stdin preserves text that gc would consume as a scope flag.
        await runBdRaw(["comment", id, "--stdin"], { ...rw(actor, "comments"), input: text });
        const bead = await show(id);
        const matching = bead.comments?.find((comment) => comment.text === text && comment.author === actor);
        if (!matching) throw new BdError(`bd comment ${id} did not read back with actor ${actor}`, "write_verification");
        return bead;
      });
    },

    addDep(id, dependsOnId, type: DepType, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "add", id, dependsOnId, "-t", type], rw(actor));
        return show(id);
      });
    },

    removeDep(id, dependsOnId, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["dep", "remove", id, dependsOnId], rw(actor));
        return show(id);
      });
    },

    createGate(blocks, reason, actor) {
      return serializeWrite(repoPath, async () => {
        const args = ["gate", "create", "--type", "human", "--blocks", blocks];
        if (reason) args.push("--reason", reason);
        // `bd gate create --json` returns the created gate object (incl. its id).
        const created = await runBdJson<{ id: string }>(args, rw(actor));
        return show(created.id);
      });
    },

    removeLabel(id, label, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["update", id, "--remove-label", label], rw(actor));
        return show(id);
      });
    },

    archive(id, actor) {
      return serializeWrite(repoPath, async () => {
        await runBdRaw(["close", id], rw(actor));
        await runBdRaw(["label", "add", id, "archived"], rw(actor));
        return show(id);
      });
    },

    async doctor(): Promise<DoctorInfo> {
      try {
        if (binding) await verifyBdBinding(binding);
        const { stdout } = await pExecFile(BD_BIN, ["--version"], { cwd: repoPath, timeout: 5000, env: nativeEnv() });
        source.cli = stdout.trim();
        return {
          kind: "bd",
          ok: true,
          version: stdout.trim(),
          repoPath,
          message: `Connected to bd at ${repoPath}`,
          source,
        };
      } catch (e) {
        return {
          kind: "bd",
          ok: false,
          repoPath,
          message: (e as Error).message,
          source,
        };
      }
    },
  };
}
