// Controlled project-switch/cache-refresh regression using isolated fixtures.
// Uses only browser-intercepted fixtures and an isolated local server.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated local server");
const bead = (id, title) => ({ id, title, status: "open", issue_type: "task", priority: 2, labels: [], dependencies: [], created_at: "2026-10-05T00:00:00Z", updated_at: "2026-10-05T00:00:00Z" });
const alpha = [bead("a-only", "Alpha-only task")];
const beta = Array.from({ length: 45 }, (_, i) => bead(`b-${i}`, `Beta task ${String(i).padStart(2,"0")}`));
let betaCalls = 0;
let releaseFirst, releaseFailure;
const firstGate = new Promise((r) => { releaseFirst = r; });
const failGate = new Promise((r) => { releaseFailure = r; });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(30000); page.setDefaultNavigationTimeout(60000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/api/projects", r => r.fulfill({ json: { projects: [
    { id: "alpha", name: "Alpha workspace", path: "/tmp/fixture-alpha", hasBeads: true },
    { id: "beta", name: "Beta workspace", path: "/tmp/fixture-beta", hasBeads: true },
  ] } }));
  await page.route("**/api/viewer-mode", r => r.fulfill({ json: { readOnly: true } }));
  await page.route("**/api/p/*/beads/stream", r => r.abort());
  await page.route("**/api/p/*/beads", async r => {
    const id = new URL(r.request().url()).pathname.split("/")[3];
    if (id === "alpha") return r.fulfill({ json: { beads: alpha, meta: { kind: "bd", humanActor: "test", humanAllowlist: ["test"], pollIntervalMs: 300000 } } });
    betaCalls++;
    if (betaCalls === 1) await firstGate;
    if (betaCalls > 1) { if (betaCalls === 2) await failGate; return r.fulfill({ status: 503, json: { error: "fixture refresh failed" } }); }
    return r.fulfill({ json: { beads: beta, meta: { kind: "bd", humanActor: "test", humanAllowlist: ["test"], pollIntervalMs: 1800 } } });
  });
  await page.goto(`${base}/p/alpha`);
  await page.getByText("Alpha workspace", { exact: true }).waitFor();
  assert.match(await page.getByRole("status").innerText(), /Loading tasks/);
  assert.equal(await page.getByText("Alpha-only task", { exact: true }).count(), 0);
  await page.getByText("Alpha-only task", { exact: true }).waitFor();
  await page.getByRole("button", { name: /Alpha workspace/ }).click();
  await page.getByRole("menuitem", { name: /Beta workspace/ }).click();
  await page.waitForURL("**/p/beta"); await page.getByRole("button", { name: /Beta workspace/ }).waitFor();
  assert.match(await page.getByRole("status").filter({ hasText: "Loading tasks" }).innerText(), /Loading tasks/); releaseFirst();
  await page.getByText("Beta task 00", { exact: true }).waitFor();
  const successStatus = await page.getByRole("status").filter({ hasText: /^Updated / }).innerText();
  assert.match(successStatus, /^Updated \S+/, "successful data freshness label is visible after the initial response");
  await page.getByRole("button", { name: "List", exact: true }).click();
  const scroll = page.locator("main .bd-scroll");
  await scroll.waitFor();
  await page.waitForFunction(() => { const e = document.querySelector("main .bd-scroll"); return e && e.scrollHeight > e.clientHeight; });
  await scroll.evaluate(e => { e.scrollTop = 300; });
  await page.waitForFunction(() => document.querySelector("main .bd-scroll")?.scrollTop > 0);
  const before = await scroll.evaluate(e => e.scrollTop);
  await page.getByRole("status").filter({ hasText: "Refreshing" }).waitFor();
  assert.ok(await page.getByText("Beta task 00", { exact: true }).isVisible());
  const during = await scroll.evaluate(e => e.scrollTop);
  assert.equal(during, before, "scroll remains while same-project refresh is pending");
  releaseFailure();
  await page.getByRole("status").filter({ hasText: /Refresh failed/ }).waitFor();
  assert.ok(await page.getByText("Beta task 00", { exact: true }).isVisible(), "cached tasks remain after refresh failure");
  assert.equal(await page.getByText("Alpha-only task", { exact: true }).count(), 0);
  const after = await scroll.evaluate(e => e.scrollTop);
  assert.equal(after, before, "scroll remains after refresh failure");
  const statusText = await page.getByRole("status").filter({ hasText: /Refresh failed/ }).innerText();
  assert.equal(statusText, "Refresh failed - showing saved tasks");
  console.log(JSON.stringify({ result: "PASS", betaCalls, scrollTop: { before, during, after }, renderedStatus: statusText, consoleErrors: errors }));
} finally { await browser.close(); }
