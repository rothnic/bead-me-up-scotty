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
console.log("AI provider policy and API contract passed");
