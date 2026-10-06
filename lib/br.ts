import "server-only";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beadSchema, type Bead, type CreateInput, type DepType, type UpdateInput } from "./schema";
import type { BeadsStore, DoctorInfo } from "./store";
import type { StorePolicy, StoreSource } from "./source";

const pExecFile = promisify(execFile);
const BR_BIN = process.env.SCOTTY_BR_BIN || "br";
const BR_FLAGS = ["--no-auto-import", "--no-auto-flush"];

interface BrBinding {
  repoPath: string;
  database: string;
}

function nativeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "BEADS_DIR" || key === "BEADS_DB" || key === "BEADS_DATABASE" || key.startsWith("GC_")) {
      delete env[key];
    }
  }
  return env;
}

export class BrError extends Error {
  code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "BrError";
    this.code = code;
  }
}

type BrIssue = Record<string, unknown> & { id?: unknown };
type BrListEnvelope = { issues?: unknown };
type BrDependency = {
  issue_id?: unknown;
  depends_on_id?: unknown;
  type?: unknown;
};
type BrComment = {
  id?: unknown;
  issue_id?: unknown;
  author?: unknown;
  text?: unknown;
  created_at?: unknown;
};

async function verifyBrBinding(binding: BrBinding): Promise<string> {
  let root: string;
  let expectedBeadsDir: string;
  let expectedDatabase: string;
  try {
    root = fs.realpathSync(binding.repoPath);
    expectedBeadsDir = fs.realpathSync(path.join(root, ".beads"));
    expectedDatabase = fs.realpathSync(path.resolve(root, binding.database));
  } catch (error) {
    throw new BrError(`br source root/database is unavailable: ${(error as Error).message}`, "source_binding");
  }
  try {
    const { stdout } = await pExecFile(BR_BIN, ["where", "--json", ...BR_FLAGS], {
      cwd: root,
      timeout: 5000,
      env: nativeEnv(),
    });
    const value = parseJson<unknown>(stdout, "where");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("where returned no workspace object");
    }
    const where = value as { path?: unknown; database_path?: unknown };
    const actualBeadsDir = typeof where.path === "string" ? fs.realpathSync(where.path) : "";
    const actualDatabase = typeof where.database_path === "string" ? fs.realpathSync(where.database_path) : "";
    if (actualBeadsDir !== expectedBeadsDir || actualDatabase !== expectedDatabase) {
      throw new BrError(
        `br source binding mismatch; expected ${expectedBeadsDir}/${expectedDatabase}, observed ${String(where.path)}/${String(where.database_path)}`,
        "source_binding",
      );
    }
    return actualDatabase;
  } catch (error) {
    if (error instanceof BrError) throw error;
    throw new BrError(`br workspace verification failed: ${(error as Error).message}`, "source_binding");
  }
}

async function runBr(
  args: string[],
  repoPath: string,
  opts: { actor?: string; binding?: BrBinding } = {},
): Promise<string> {
  try {
    const databasePath = opts.binding ? await verifyBrBinding(opts.binding) : undefined;
    const commandArgs = [
      ...(opts.actor ? ["--actor", opts.actor] : []),
      ...(databasePath ? ["--db", databasePath] : []),
      ...args,
      ...BR_FLAGS,
    ];
    const { stdout } = await pExecFile(BR_BIN, commandArgs, {
      cwd: repoPath,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...nativeEnv(), BR_OUTPUT_FORMAT: "json" },
    });
    return stdout;
  } catch (err: unknown) {
    if (err instanceof BrError) throw err;
    const e = err as { stderr?: string; stdout?: string; message?: string };
    throw new BrError((e.stderr || e.stdout || e.message || "br command failed").trim());
  }
}

function parseJson<T>(output: string, command: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new BrError(`br ${command} returned invalid JSON`, "parse_error");
  }
}

function firstRecord(output: string, command: string, expectedId?: string): BrIssue {
  const raw = parseJson<unknown>(output, command);
  const record = Array.isArray(raw) ? raw[0] : raw;
  if (!record || typeof record !== "object") {
    throw new BrError(`br ${command} returned no issue record`, "parse_error");
  }
  const issue = record as BrIssue;
  if (expectedId && issue.id !== expectedId) {
    throw new BrError(`br ${command} returned issue ${stringOrDefault(issue.id, "<missing>")} instead of ${expectedId}`, "parse_error");
  }
  return issue;
}

function dependencyRows(output: string, command: string): BrDependency[] {
  const raw = parseJson<unknown>(output, command);
  if (!Array.isArray(raw)) throw new BrError(`br ${command} returned a non-array edge set`, "parse_error");
  return raw.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new BrError(`br ${command} returned malformed edge ${index}`, "parse_error");
    }
    return row as BrDependency;
  });
}

function commentRows(output: string, command: string, expectedId: string): BrComment[] {
  const raw = parseJson<unknown>(output, command);
  if (!Array.isArray(raw)) throw new BrError(`br ${command} returned a non-array comment set`, "parse_error");
  return raw.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new BrError(`br ${command} returned malformed comment ${index}`, "parse_error");
    }
    const comment = row as BrComment;
    if (typeof comment.issue_id !== "string" || comment.issue_id !== expectedId) {
      throw new BrError(`br ${command} returned comment ${index} for the wrong issue`, "parse_error");
    }
    if (typeof comment.text !== "string" || !comment.text) {
      throw new BrError(`br ${command} returned comment ${index} without text`, "parse_error");
    }
    if (typeof comment.author !== "string" || !comment.author) {
      throw new BrError(`br ${command} returned comment ${index} without an actor`, "parse_error");
    }
    return comment;
  });
}

function stringOrDefault(value: unknown, otherwise = ""): string {
  return typeof value === "string" ? value : otherwise;
}

function assertIssueId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) {
    throw new BrError("Invalid native br issue id", "invalid_input");
  }
}

function assertCommentText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 10000 || trimmed.includes("\0")) {
    throw new BrError("Comment text must be non-empty and at most 10000 characters", "invalid_input");
  }
  return trimmed;
}

function normalizeIssue(
  row: BrIssue,
  detail: BrIssue,
  dependencies: BrDependency[],
  comments: BrComment[],
  expectedId: string,
): Bead {
  const merged: Record<string, unknown> = { ...row, ...detail };
  for (const field of ["description", "notes", "design", "acceptance_criteria", "assignee", "created_by"]) {
    if (merged[field] == null) merged[field] = "";
  }
  if (!Array.isArray(merged.labels)) merged.labels = [];
  merged.dependencies = dependencies.map((edge, index) => {
    if (typeof edge.issue_id !== "string" || !edge.issue_id || edge.issue_id !== expectedId) {
      throw new BrError(`br dependency ${index} for ${expectedId} has an invalid issue_id`, "parse_error");
    }
    if (typeof edge.depends_on_id !== "string" || !edge.depends_on_id) {
      throw new BrError(`br dependency ${index} for ${expectedId} has an invalid depends_on_id`, "parse_error");
    }
    if (typeof edge.type !== "string" || !edge.type) {
      throw new BrError(`br dependency ${index} for ${expectedId} has an invalid type`, "parse_error");
    }
    return {
      issue_id: edge.issue_id,
      depends_on_id: edge.depends_on_id,
      type: edge.type,
    };
  });
  merged.comments = comments.map((comment) => ({
    ...(comment.id == null ? {} : { id: String(comment.id) }),
    issue_id: comment.issue_id as string,
    author: comment.author as string,
    text: comment.text as string,
    ...(comment.created_at == null ? {} : { created_at: String(comment.created_at) }),
  }));
  if (merged.owner === null) delete merged.owner;

  const parsed = beadSchema.safeParse(merged);
  if (!parsed.success) {
    const detailText = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new BrError(`could not parse PM br issue ${stringOrDefault(merged.id, "<unknown>")}: ${detailText}`, "parse_error");
  }
  return parsed.data;
}

function statusCounts(beads: Bead[]): Record<string, number> {
  return beads.reduce<Record<string, number>>((counts, bead) => {
    counts[bead.status] = (counts[bead.status] || 0) + 1;
    return counts;
  }, {});
}

/**
 * Read-only bridge for the configured `br` CLI. It deliberately uses
 * br's native SQLite JSON surfaces instead of the incompatible bd export shape.
 */
export function createBrStore(repoPath: string, policy: StorePolicy = {}): BeadsStore {
  const managed = policy.managed === true;
  const readOnly = policy.readOnly ?? true;
  const capabilities = policy.capabilities ?? { comments: false, priority: false };
  const source: StoreSource = {
    kind: "br",
    managed,
    label: policy.label ?? "br source",
    scope: policy.scope ?? "configured source",
    root: repoPath,
    cli: null,
    nativeProjectId: policy.nativeProjectId ?? null,
    database: policy.database ?? null,
    readOnly,
    capabilities,
    readAt: null,
    newestRecordUpdatedAt: null,
  };
  const binding = managed && policy.database ? { repoPath, database: policy.database } : undefined;

  const assertWritable = (capability: "comments" | "priority") => {
    if (readOnly) throw new BrError("The canonical br backend is read-only in Scotty", "read_only");
    if (!capabilities[capability]) throw new BrError(`The br backend does not allow ${capability}`, "capability_unavailable");
  };

  async function list(): Promise<Bead[]> {
    if (!source.cli) {
      source.cli = (await pExecFile(BR_BIN, ["--version"], { cwd: repoPath })).stdout.trim();
    }
    const listed = parseJson<BrListEnvelope>(
      await runBr(["list", "--all", "--deferred", "--json"], repoPath),
      "list",
    );
    if (!Array.isArray(listed.issues)) throw new BrError("br list returned no issues array", "parse_error");

    const beads: Bead[] = [];
    let edgeCount = 0;
    for (const rawRow of listed.issues) {
      if (!rawRow || typeof rawRow !== "object") throw new BrError("br list returned a malformed issue", "parse_error");
      const row = rawRow as BrIssue;
      const id = stringOrDefault(row.id);
      if (!id) throw new BrError("br list returned an issue without an id", "parse_error");
      const detail = firstRecord(await runBr(["show", id, "--json"], repoPath), `show ${id}`, id);
      const dependencies = dependencyRows(
        await runBr(["dep", "list", id, "--direction", "down", "--json"], repoPath),
        `dep list ${id}`,
      );
      const comments = commentRows(
        await runBr(["comments", "list", id, "--json"], repoPath),
        `comments list ${id}`,
        id,
      );
      edgeCount += dependencies.length;
      beads.push(normalizeIssue(row, detail, dependencies, comments, id));
    }

    const readAt = new Date().toISOString();
    const newestRecordUpdatedAt = beads
      .map((bead) => bead.updated_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;
    source.readAt = readAt;
    source.newestRecordUpdatedAt = newestRecordUpdatedAt;
    source.recordCount = beads.length;
    source.edgeCount = edgeCount;
    source.statusCounts = statusCounts(beads);
    return beads;
  }

  async function get(id: string): Promise<Bead | null> {
    assertIssueId(id);
    try {
      const detail = firstRecord(await runBr(["show", id, "--json"], repoPath), `show ${id}`, id);
      const dependencies = dependencyRows(
        await runBr(["dep", "list", id, "--direction", "down", "--json"], repoPath),
        `dep list ${id}`,
      );
      const comments = commentRows(
        await runBr(["comments", "list", id, "--json"], repoPath),
        `comments list ${id}`,
        id,
      );
      return normalizeIssue(detail, detail, dependencies, comments, id);
    } catch (error) {
      if (error instanceof BrError && /not found|unknown issue|no issue/i.test(error.message)) return null;
      throw error;
    }
  }

  const blocked = async (): Promise<never> => {
    throw new BrError("This native br operation is unavailable in Scotty", "capability_unavailable");
  };

  return {
    kind: "br",
    source,
    list,
    get,
    create: blocked as (input: CreateInput, actor: string) => Promise<Bead>,
    async update(id: string, patch: UpdateInput, actor: string): Promise<Bead> {
      assertWritable("priority");
      assertIssueId(id);
      const keys = Object.keys(patch);
      const priority = patch.priority;
      if (keys.length !== 1 || keys[0] !== "priority" || typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) {
        throw new BrError("Managed br updates allow only priority", "capability_unavailable");
      }
      // Bind the request to the exact native id before writing. `br` accepts
      // prefixes; get() verifies the returned id and therefore rejects an
      // abbreviated or otherwise mismatched target before update runs.
      const before = await get(id);
      if (!before) throw new BrError(`br update target ${id} was not found`, "not_found");
      await runBr(["update", id, "--priority", String(priority), "--json"], repoPath, { actor, binding });
      const result = await get(id);
      if (!result) throw new BrError(`br update ${id} returned no issue`, "write_verification");
      if (result.id !== id || result.priority !== priority) {
        throw new BrError(`br update ${id} did not read back priority ${priority}`, "write_verification");
      }
      return result;
    },
    setStatus: blocked as (id: string, status: string, actor: string, reason?: string) => Promise<Bead>,
    remove: blocked as (id: string, actor: string) => Promise<void>,
    async addComment(id: string, text: string, actor: string): Promise<Bead> {
      assertWritable("comments");
      assertIssueId(id);
      const comment = assertCommentText(text);
      const before = await get(id);
      if (!before) throw new BrError(`br comment target ${id} was not found`, "not_found");
      // Keep the freeform text attached to the option so a leading hyphen in
      // the comment cannot be parsed as another br flag.
      await runBr(["comments", "add", id, `--message=${comment}`, "--json"], repoPath, { actor, binding });
      const result = await get(id);
      if (!result) throw new BrError(`br comment ${id} returned no issue`, "write_verification");
      const beforeCount = before.comments?.length ?? 0;
      const afterComments = result.comments ?? [];
      const matching = afterComments.find((item) => item.text === comment && item.author === actor);
      if (afterComments.length <= beforeCount || !matching) {
        throw new BrError(`br comment ${id} did not read back with actor ${actor}`, "write_verification");
      }
      return result;
    },
    addDep: blocked as (id: string, dependsOnId: string, type: DepType, actor: string) => Promise<Bead>,
    removeDep: blocked as (id: string, dependsOnId: string, actor: string) => Promise<Bead>,
    createGate: blocked as (blocks: string, reason: string | undefined, actor: string) => Promise<Bead>,
    removeLabel: blocked as (id: string, label: string, actor: string) => Promise<Bead>,
    archive: blocked as (id: string, actor: string) => Promise<Bead>,
    async doctor(): Promise<DoctorInfo> {
      let version = "unknown";
      try {
        version = (await pExecFile(BR_BIN, ["--version"], { cwd: repoPath })).stdout.trim();
      } catch (error: unknown) {
        const e = error as { message?: string };
        return { kind: "br", ok: false, repoPath, message: e.message || "br --version failed", source };
      }
      source.cli = version;
      return {
        kind: "br",
        ok: true,
        version,
        repoPath,
        message: managed
          ? `Connected to canonical br at ${repoPath} (comments/priority only)`
          : `Connected to canonical br at ${repoPath} (read-only)`,
        source,
      };
    },
  };
}

export async function isBrAvailable(repoPath: string, policy: StorePolicy = {}): Promise<boolean> {
  try {
    if (policy.managed) {
      if (!policy.database) return false;
      await verifyBrBinding({ repoPath, database: policy.database });
    }
    await pExecFile(BR_BIN, ["--version"], { cwd: repoPath, timeout: 5000, env: nativeEnv() });
    return true;
  } catch {
    return false;
  }
}
