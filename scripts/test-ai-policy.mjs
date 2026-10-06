import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("../lib/ai.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

let execCalls = 0;
let spawnCalls = 0;
let authEnvReads = 0;
const controlledEnv = new Proxy({ ANTHROPIC_API_KEY: "synthetic-test-value", CLAUDE_BIN: "synthetic-test-command" }, {
  get(target, key) {
    if (key === "ANTHROPIC_API_KEY" || key === "CLAUDE_BIN") authEnvReads++;
    return target[key];
  },
});
const appModule = { exports: {} };
const context = {
  exports: appModule.exports,
  module: appModule,
  process: { env: controlledEnv },
  require(name) {
    if (name === "server-only") return {};
    if (name === "node:child_process") {
      return {
        execFile(...args) { execCalls++; return args; },
        spawn(...args) { spawnCalls++; return args; },
      };
    }
    throw new Error(`Unexpected import: ${name}`);
  },
};
vm.runInNewContext(compiled, context, { filename: "lib/ai.ts" });

assert.equal(await appModule.exports.isClaudeAvailable(), false);
await assert.rejects(
  appModule.exports.assistBead({ id: "x", title: "x", description: "", type: "task", labels: [], others: [] }),
  (error) => error instanceof appModule.exports.AiError && error.code === "provider_prohibited",
);
assert.equal(execCalls, 0, "availability check must not execute a command");
assert.equal(spawnCalls, 0, "assistance must not spawn a process");
assert.equal(authEnvReads, 0, "policy guard must not inspect auth or command environment variables");

const apiSource = await readFile(new URL("../lib/api.ts", import.meta.url), "utf8");
const apiCompiled = ts.transpileModule(apiSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
class StubError extends Error {}
const apiModule = { exports: {} };
const apiContext = {
  exports: apiModule.exports,
  module: apiModule,
  require(name) {
    if (name === "server-only") return {};
    if (name === "next/server") return { NextResponse: { json: (body, init) => ({ body, status: init.status }) } };
    if (name === "zod") return { ZodError: class ZodError extends Error {} };
    if (name === "./bd" || name === "./br" || name === "./config") {
      return {
        BdError: StubError,
        BrError: StubError,
        ConfigError: StubError,
        configuredWriteOrigin() {},
        isHardReadOnly() {},
        isManagedRegistryMode() {},
        isReadOnly() {},
      };
    }
    if (name === "./ai") return appModule.exports;
    throw new Error(`Unexpected API import: ${name}`);
  },
};
vm.runInNewContext(apiCompiled, apiContext, { filename: "lib/api.ts" });
const response = apiModule.exports.fail(new appModule.exports.AiError("Provider prohibited", "provider_prohibited"));
assert.equal(response.status, 403);
assert.equal(response.body.code, "provider_prohibited");
assert.match(response.body.error, /provider prohibited/i);
assert.equal(execCalls, 0, "API error mapping must not execute a command");
assert.equal(spawnCalls, 0, "API error mapping must not spawn a process");
assert.equal(authEnvReads, 0, "API error mapping must not inspect auth or command environment variables");

let managedMode = true;
let handlerEffects = 0;
class ConfigError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}
const managedConfig = {
  ConfigError,
  DEMO_PROJECT: { id: "demo" },
  getProject() { handlerEffects++; },
  getConfig() { handlerEffects++; },
  isManagedRegistryMode() { return managedMode; },
  configuredWriteOrigin() {},
  isHardReadOnly() {},
  isReadOnly() {},
};
const managedApiModule = { exports: {} };
vm.runInNewContext(apiCompiled, {
  exports: managedApiModule.exports,
  module: managedApiModule,
  require(name) {
    if (name === "server-only") return {};
    if (name === "next/server") return { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200 }) } };
    if (name === "zod") return { ZodError: class ZodError extends Error {} };
    if (name === "./bd") return { BdError: class BdError extends Error {} };
    if (name === "./br") return { BrError: class BrError extends Error {} };
    if (name === "./config") return managedConfig;
    if (name === "./ai") return appModule.exports;
    throw new Error(`Unexpected API import: ${name}`);
  },
}, { filename: "lib/api.ts (managed mode)" });
managedMode = false;
assert.doesNotThrow(() => managedApiModule.exports.assertUnmanagedOperation(), "ordinary mode remains allowed");
managedMode = true;

const chainSchema = () => new Proxy({ parse: (value) => value }, {
  get(target, key) { return key in target ? target[key] : () => chainSchema(); },
});
const zStub = new Proxy({}, { get: () => () => chainSchema() });
const storeStub = {
  addComment() { handlerEffects++; },
  removeLabel() { handlerEffects++; },
};
const loaderMocks = {
  "server-only": {},
  "node:fs": new Proxy({}, { get: () => () => { handlerEffects++; } }),
  "node:path": new Proxy({}, { get: () => () => { handlerEffects++; return "synthetic-path"; } }),
  "node:crypto": { randomUUID: () => { handlerEffects++; return "synthetic-uuid"; } },
  "node:child_process": { execFile: () => { handlerEffects++; } },
  "node:util": { promisify: () => () => { handlerEffects++; } },
  zod: { z: zStub },
  "@/lib/api": managedApiModule.exports,
  "@/lib/config": managedConfig,
  "@/lib/showcase/generate": { buildShowcase: () => { handlerEffects++; } },
  "@/lib/self-update": { runUpdate: () => { handlerEffects++; }, RESTART_EXIT_CODE: 0 },
  "@/lib/store": { getStore: async () => { handlerEffects++; return storeStub; } },
};
const handlers = [
  ["../app/api/p/[projectId]/attachments/route.ts", ["POST", "PUT"]],
  ["../app/api/p/[projectId]/publish/route.ts", ["POST"]],
  ["../app/api/update/run/route.ts", ["POST"]],
  ["../app/api/p/[projectId]/beads/[id]/human/route.ts", ["POST"]],
];
for (const [relativeFile, methods] of handlers) {
  const handlerSource = await readFile(new URL(relativeFile, import.meta.url), "utf8");
  const handlerCompiled = ts.transpileModule(handlerSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const handlerModule = { exports: {} };
  vm.runInNewContext(handlerCompiled, {
    exports: handlerModule.exports,
    module: handlerModule,
    process: { platform: "linux" },
    require(name) {
      if (Object.hasOwn(loaderMocks, name)) return loaderMocks[name];
      throw new Error(`Unexpected handler import: ${name}`);
    },
  }, { filename: relativeFile });
  for (const method of methods) {
    const req = {
      async json() { handlerEffects++; throw new Error("body read before managed guard"); },
      async formData() { handlerEffects++; throw new Error("body read before managed guard"); },
    };
    const ctx = { params: Promise.resolve({ projectId: "synthetic", id: "synthetic" }) };
    const response = method === "POST" && relativeFile.includes("update/run")
      ? await handlerModule.exports[method](req)
      : await handlerModule.exports[method](req, ctx);
    assert.equal(response.status, 403, `${relativeFile} ${method} should deny managed-mode operation`);
    assert.equal(response.body.code, "capability_unavailable");
    assert.match(response.body.error, /unavailable for managed projects/i);
  }
}
assert.equal(handlerEffects, 0, "managed handlers must stop before body, params, store, filesystem, CLI, deployment, or comment effects");
assert.equal(execCalls, 0, "managed handlers must not execute a command");
assert.equal(spawnCalls, 0, "managed handlers must not spawn a process");
assert.equal(authEnvReads, 0, "managed handlers must not inspect auth or command environment variables");
console.log("AI policy, API contract, and managed operation guards passed");
