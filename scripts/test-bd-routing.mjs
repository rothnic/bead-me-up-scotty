import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// Exercise the real adapter with a synthetic CLI boundary. No native processes,
// stores, credentials, network, or app server are used by this regression.
const require = createRequire(import.meta.url);
const ts = require("typescript");
const childProcess = require("node:child_process");
const originalExec = childProcess.execFile;
const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "scotty-bd-routing-"));
const project = path.join(root, "project-1");
const city = path.join(root, "city");
const worktree = path.join(root, "outside-rig-worktree");
fs.mkdirSync(path.join(project, ".beads"), { recursive: true });
fs.mkdirSync(city);
const canonicalProject = fs.realpathSync(project);
const canonicalCity = fs.realpathSync(city);
fs.mkdirSync(worktree);
const canonicalWorktree = fs.realpathSync(worktree);
const calls = [];
const bead = { id: "p1-task", title: "Synthetic task", status: "open", issue_type: "task", priority: 2 };
const policy = { managed: true, nativeProjectId: "project-uuid-1", database: "project1", capabilities: { comments: true, priority: true } };
const ambientKeys = ["GC_CITY", "GC_RIG", "GC_DOLT_PORT", "BEADS_DIR", "BEADS_DB", "BEADS_DATABASE"];
const priorEnv = Object.fromEntries(ambientKeys.map((key) => [key, process.env[key]]));
const priorRegistry = process.env.SCOTTY_PROJECTS_FILE;
let state;
let passed = 0;

function reset(extra = {}) {
  calls.length = 0;
  bead.priority = 2;
  state = { ordinary: false, port: 41001, context: {}, comments: [], ...extra };
}
function fail(stdout) {
  throw Object.assign(new Error("Synthetic CLI failure"), { stdout: JSON.stringify(stdout) });
}
function noCity() {
  return { ok: false, error: { code: "city_resolve_failed", message: "gc rig list: not in a city directory (no city.toml or .gc/ found)" } };
}

async function fakeExec(bin, argv, options) {
  calls.push({ bin, argv, cwd: options.cwd, env: options.env });
  for (const key of ambientKeys) assert.equal(options.env?.[key], undefined, `ambient ${key} leaked`);
  if (bin === "git") {
    assert.deepEqual(argv, ["worktree", "list", "--porcelain", "-z"]);
    if (state.gitError) throw new Error("Synthetic Git failure");
    return { stdout: `worktree ${project}\0HEAD synthetic\0\0worktree ${worktree}\0HEAD synthetic\0\0` };
  }
  if (argv.includes("rig") && argv.includes("list")) {
    if (state.discoveryError) fail(state.discoveryError);
    if (state.ordinary) fail(noCity());
    const rigs = [
      { name: "city", path: city, hq: true }, { name: "project-1", path: project, hq: false },
      ...(state.extraRigs || []),
    ];
    return { stdout: JSON.stringify({ ok: true, schema_version: "1", city_path: city, rigs, summary: { total: rigs.length }, ...state.registry }) };
  }
  if (argv.includes("--version")) return { stdout: "bd version synthetic" };
  const gc = bin === "gc";
  if (gc) {
    assert.deepEqual(argv.slice(0, 5), ["--city", canonicalCity, "bd", "--rig", "project-1"], "every rig operation must be explicitly scoped");
    assert.deepEqual(argv.slice(5, 7), ["--directory", fs.realpathSync(options.cwd)], "native bd must retain the configured worktree");
    assert.ok(argv.slice(7).every((arg) => !/^--(?:city|rig)(?:=|$)/.test(arg)), "data values cannot enter native scope extraction");
  }
  let args = gc ? argv.slice(7) : argv.slice();
  const readonly = args.includes("--readonly");
  args = args.filter((arg) => arg !== "--readonly" && arg !== "--json");
  let actor = options.env.BEADS_ACTOR;
  if (args[0] === "--actor") [actor, args] = [args[1], args.slice(2)];
  const command = args[0];
  if (command === "context") {
    assert.ok(readonly, "context must be read-only");
    return { stdout: JSON.stringify({ data: {
      cwd_repo_root: options.cwd, repo_root: canonicalProject, beads_dir: path.join(gc ? canonicalProject : options.cwd, ".beads"),
      project_id: policy.nativeProjectId, database: policy.database, backend: "dolt", dolt_mode: "server",
      server_host: "127.0.0.1", server_port: gc ? state.port : 40000, ...state.context,
    } }) };
  }
  if (["export", "show", "comments"].includes(command)) assert.ok(readonly || !state.expectManaged, "managed data reads must be read-only");
  if (command === "export") return { stdout: JSON.stringify({ ...bead, title: gc ? "Authoritative result" : "Direct project result" }) + "\n" };
  if (command === "show") return { stdout: JSON.stringify({ data: [{ ...bead, id: state.alias ? "p1-task-longer" : bead.id }] }) };
  if (command === "comments") return { stdout: JSON.stringify({ data: state.comments }) };
  if (command === "comment") {
    assert.equal(readonly, false);
    assert.deepEqual(args.slice(1), [bead.id, "--stdin"]);
    state.comments.push({ issue_id: bead.id, text: options.syntheticInput, author: actor });
    return { stdout: "" };
  }
  if (command === "update") {
    assert.equal(readonly, false);
    assert.deepEqual(args.slice(1, 3), [bead.id, "--priority"]);
    bead.priority = Number(args[3]);
    return { stdout: "" };
  }
  throw new Error(`Unexpected synthetic operation: ${command}`);
}
const mockedExec = () => { throw new Error("The adapter must use the promisified CLI boundary"); };
mockedExec[promisify.custom] = (bin, argv, options) => {
  const execution = Promise.resolve().then(() => fakeExec(bin, argv, options));
  execution.child = { stdin: {
    on() { return this; },
    end(input) { options.syntheticInput = input; },
  } };
  return execution;
};

function mutations() { return calls.filter((c) => c.argv.includes("comment") || c.argv.includes("update")); }
async function check(name, run) {
  reset({ expectManaged: true });
  await run();
  passed++;
  console.log(`PASS ${name}`);
}

try {
  childProcess.execFile = mockedExec;
  Module._load = function (request, ...rest) {
    if (request === "server-only") return {};
    return originalLoad.call(this, request, ...rest);
  };
  Module._extensions[".ts"] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
    } }).outputText;
    module._compile(output, filename);
  };
  for (const key of ambientKeys) process.env[key] = "synthetic-wrong-route";
  const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { createBdStore, isBdAvailable } = require(path.join(directory, "lib/bd.ts"));

  await check("same UUID alternate direct route is never used for a registered project", async () => {
    const store = createBdStore(project, policy);
    assert.equal((await store.list())[0].title, "Authoritative result");
    assert.ok(calls.every((c) => ["gc", "git"].includes(c.bin)));
    assert.equal(store.source.route.endpoint.port, 41001);
  });
  await check("existing store follows native port rebinding without a pin or cached route", async () => {
    const store = createBdStore(project, policy);
    await store.list();
    state.port = 42002;
    await store.list();
    assert.equal(store.source.route.endpoint.port, 42002);
    assert.equal(calls.filter((c) => c.argv.includes("context")).length, 2);
  });
  for (const declared of [false, true]) {
    await check(`${declared ? "declared" : "implicit"} rig worktree uses canonical project authority and exact caller root`, async () => {
      const store = createBdStore(worktree, { ...policy, ...(declared ? { city, rig: "project-1" } : {}) });
      assert.equal(await isBdAvailable(worktree, { ...policy, ...(declared ? { city, rig: "project-1" } : {}) }), true);
      assert.equal((await store.list())[0].title, "Authoritative result");
      await store.addComment(bead.id, "synthetic worktree result", "test-actor");
      assert.ok(calls.filter((c) => c.argv.includes("rig") && c.argv.includes("list")).every((c) => c.cwd === canonicalProject));
      assert.ok(calls.filter((c) => c.argv.includes("export") || c.argv.includes("comment")).every((c) => c.bin === "gc" && c.cwd === worktree));
    });
  }
  for (const context of [
    { server_host: "" }, { server_host: "wrong host" }, { server_port: undefined },
    { server_port: 0 }, { server_port: 70000 }, { server_port: "41001" },
    { dolt_mode: "embedded" }, { dolt_mode: undefined },
    { database: "other" }, { project_id: "other" }, { beads_dir: root }, { cwd_repo_root: root }, { repo_root: root },
  ]) {
    await check(`bad binding blocks data: ${JSON.stringify(context)}`, async () => {
      state.context = context;
      await assert.rejects(createBdStore(project, policy).list(), { code: "source_binding" });
      assert.ok(!calls.some((c) => c.argv.includes("export")));
    });
  }
  await check("discovery outage does not fall back to same-UUID direct store", async () => {
    state.discoveryError = { ok: false, error: { code: "city_resolve_failed", message: "registry is unavailable" } };
    await assert.rejects(createBdStore(project, policy).list(), { code: "source_binding" });
    assert.ok(calls.every((c) => ["gc", "git"].includes(c.bin)));
  });
  await check("explicit missing city fails closed instead of using an ordinary route", async () => {
    state.ordinary = true;
    await assert.rejects(createBdStore(project, { ...policy, city, rig: "project-1" }).list(), { code: "source_binding" });
    assert.ok(calls.every((c) => ["gc", "git"].includes(c.bin)));
  });
  await check("wrong declared rig and ambiguous project roots fail closed", async () => {
    await assert.rejects(createBdStore(project, { ...policy, city, rig: "project-2" }).list(), { code: "source_binding" });
    state.extraRigs = [{ name: "project-2", path: project, hq: false }];
    await assert.rejects(createBdStore(project, policy).list(), { code: "source_binding" });
  });
  for (const registry of [
    { rigs: [], summary: { total: 0 } },
    { rigs: [{ name: "project-1", path: project, hq: false }], summary: { total: 1 } },
    { rigs: [{ name: "city", path: city, hq: true }, { name: "project-1", hq: false }] },
    { summary: { total: 1 } }, { schema_version: "unknown" },
    { rigs: [{ name: "city", path: project, hq: true }, { name: "project-1", path: project, hq: false }] },
  ]) {
    await check(`malformed or incomplete registry cannot permit direct fallback: ${JSON.stringify(registry)}`, async () => {
      state.registry = registry;
      await assert.rejects(createBdStore(project, policy).list(), { code: "source_binding" });
      assert.ok(!calls.some((c) => c.argv.includes("context") || c.argv.includes("export")));
    });
  }
  await check("offline and unbound unrelated rigs do not disable the healthy target", async () => {
    state.extraRigs = [
      { name: "project-2", path: path.join(root, "offline-project"), hq: false },
      { name: "project-n", path: "", hq: false },
    ];
    assert.equal((await createBdStore(project, policy).list())[0].title, "Authoritative result");
  });
  await check("qualified city registry preserves an ordinary unregistered project", async () => {
    state.registry = { rigs: [{ name: "city", path: city, hq: true }], summary: { total: 1 } };
    assert.equal((await createBdStore(project, policy).list())[0].title, "Direct project result");
  });
  await check("unavailable canonical repository cannot permit direct fallback", async () => {
    state.gitError = true;
    await assert.rejects(createBdStore(project, policy).list(), { code: "source_binding" });
    assert.ok(calls.every((c) => c.bin === "git"));
  });
  await check("ordinary managed non-rig projects use direct bd", async () => {
    state.ordinary = true;
    const store = createBdStore(project, policy);
    assert.equal((await store.list())[0].title, "Direct project result");
    assert.deepEqual(store.source.route, { kind: "direct", endpoint: { host: "127.0.0.1", port: 40000 } });
    assert.ok(calls.filter((c) => c.argv.includes("export")).every((c) => c.bin === "bd"));
  });
  await check("ordinary embedded projects retain local authority", async () => {
    state.ordinary = true;
    state.context = { dolt_mode: "embedded", server_host: undefined, server_port: undefined };
    const store = createBdStore(project, policy);
    await store.list();
    assert.equal(store.source.route.endpoint, null);
  });
  await check("unmanaged direct projects do not require Gas City", async () => {
    state.expectManaged = false;
    await createBdStore(project).list();
    assert.ok(calls.every((c) => c.bin === "bd"));
  });
  await check("managed comment and priority retain exact-ID actor/text readback", async () => {
    const store = createBdStore(project, policy);
    const comment = await store.addComment(bead.id, "--help is synthetic comment text", "test-actor");
    assert.equal(comment.comments[0].author, "test-actor");
    assert.equal((await store.update(bead.id, { priority: 1 }, "test-actor")).priority, 1);
    assert.equal(mutations().length, 2);
    assert.ok(mutations().every((c) => c.bin === "gc"));
  });
  for (const text of ["--city=/another-city", "--rig=project-2", "--rig", "First line\n--city=/another-city\nLast line"]) {
    await check(`native scope-like comment and actor stay data: ${JSON.stringify(text)}`, async () => {
      const actor = "--rig=actor-is-data";
      const result = await createBdStore(project, policy).addComment(bead.id, text, actor);
      assert.equal(result.comments[0].text, text);
      assert.equal(result.comments[0].author, actor);
      assert.ok(mutations().every((call) => call.bin === "gc" && !call.argv.slice(7).includes(text) && !call.argv.includes(actor)));
    });
  }
  await check("read-only and capability guards deny mutations", async () => {
    await assert.rejects(createBdStore(project, { ...policy, readOnly: true }).addComment(bead.id, "text", "actor"), { code: "read_only" });
    const store = createBdStore(project, { ...policy, capabilities: { comments: false, priority: false } });
    await assert.rejects(store.addComment(bead.id, "text", "actor"), { code: "capability_unavailable" });
    await assert.rejects(store.update(bead.id, { priority: 1 }, "actor"), { code: "capability_unavailable" });
    await assert.rejects(store.setStatus(bead.id, "closed", "actor"), { code: "capability_unavailable" });
    await assert.rejects(store.update(bead.id, { priority: 1, status: "closed" }, "actor"), { code: "capability_unavailable" });
    assert.equal(mutations().length, 0);
  });
  await check("abbreviated ID cannot mutate its longer native match", async () => {
    state.alias = true;
    const store = createBdStore(project, policy);
    await assert.rejects(store.addComment(bead.id, "text", "actor"), { code: "parse_error" });
    await assert.rejects(store.update(bead.id, { priority: 1 }, "actor"), { code: "parse_error" });
    assert.equal(mutations().length, 0);
  });
  await check("availability and doctor cannot report healthy on a missing endpoint", async () => {
    state.context = { server_port: undefined };
    await assert.rejects(isBdAvailable(project, policy), { code: "source_binding" });
    assert.equal((await createBdStore(project, policy).doctor()).ok, false);
  });
  await check("managed sources require static identity", async () => {
    assert.throws(() => createBdStore(project, { managed: true }), { code: "source_binding" });
  });
  await check("registry city/rig binding reaches the adapter unchanged", async () => {
    const registry = path.join(root, "registry.json");
    fs.writeFileSync(registry, JSON.stringify([{
      id: "project-1", name: "Project 1", backend: "bd", path: canonicalWorktree, nativeProjectId: policy.nativeProjectId,
      database: policy.database, sourceLabel: "Synthetic", sourceScope: "Synthetic project", readOnly: true,
      capabilities: { comments: false, priority: false }, city, rig: "project-1",
    }]));
    process.env.SCOTTY_PROJECTS_FILE = registry;
    const { getStore } = require(path.join(directory, "lib/store.ts"));
    // Preserve the immutable registry's initialized-root prerequisite. Native
    // routing then binds this worktree to the canonical rig's actual store.
    await assert.rejects(getStore("project-1"), { code: "registry_path_not_allowed" });
    fs.mkdirSync(path.join(worktree, ".beads"));
    const store = await getStore("project-1");
    await store.list();
    assert.equal(store.source.route.rig, "project-1");
    assert.equal(store.source.readOnly, true);
    state.ordinary = true;
    await assert.rejects(store.list(), { code: "source_binding" });
  });
  console.log(`PASS: ${passed} deterministic routing/binding/access checks; native processes and network calls: 0`);
} finally {
  childProcess.execFile = originalExec;
  Module._load = originalLoad;
  if (originalTs) Module._extensions[".ts"] = originalTs;
  else delete Module._extensions[".ts"];
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (priorRegistry === undefined) delete process.env.SCOTTY_PROJECTS_FILE;
  else process.env.SCOTTY_PROJECTS_FILE = priorRegistry;
  fs.rmSync(root, { recursive: true, force: true });
}
