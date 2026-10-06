import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated Scotty server");

const browser = await chromium.launch();
try {
  for (const size of ["small", "large"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript((bannerSize) => {
      try {
        localStorage.setItem("scotty.read-only-banner", JSON.stringify({
          size: bannerSize,
          background: "#fff3cd",
          text: "#664d03",
        }));
      } catch { /* The app falls back to its default preferences. */ }
    }, size);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    let resolveRequestStarted;
    const requestStarted = new Promise((resolve) => { resolveRequestStarted = resolve; });

    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith("/beads/stream")) return route.abort();
      if (request.method() === "GET" && path === "/api/viewer-mode") {
        resolveRequestStarted();
        await new Promise((resolve) => setTimeout(resolve, 900));
        return route.fulfill({ json: { readOnly: true } });
      }
      if (request.method() === "GET" && path === "/api/p/demo/beads") {
        resolveRequestStarted();
        await new Promise((resolve) => setTimeout(resolve, 900));
        return route.fulfill({ json: { beads: [], meta: { kind: "demo", humanActor: "reviewer", humanAllowlist: ["reviewer"], pollIntervalMs: 300_000 } } });
      }
      if (request.method() === "GET" && path === "/api/projects") {
        return route.fulfill({ json: { projects: [] } });
      }
      return route.continue();
    });

    await page.goto(`${base}/p/demo`, { waitUntil: "domcontentloaded" });
    await page.locator("main").waitFor();
    await requestStarted;
    const measure = () => page.evaluate(() => {
      const main = document.querySelector("main");
      const banner = [...document.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "Read Only Mode");
      return {
        mainTop: main?.getBoundingClientRect().top ?? null,
        bannerTop: banner?.getBoundingClientRect().top ?? null,
        bannerHeight: banner?.getBoundingClientRect().height ?? null,
        viewport: `${innerWidth}x${innerHeight}`,
      };
    });
    const before = await measure();
    assert.equal(await page.getByRole("button", { name: "Read Only Mode", exact: true }).count(), 0, `${size}: banner should not show before viewer-mode response`);
    await page.getByRole("button", { name: "Read Only Mode", exact: true }).waitFor();
    const after = await measure();
    assert.equal(after.bannerHeight, size === "large" ? 48 : 28, `${size}: banner keeps the configured height`);
    assert.equal(after.mainTop, before.mainTop, `${size}: main content must not move when the banner appears`);

    await page.getByRole("button", { name: "Read Only Mode", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog.getByText(/Editing is disabled for this browser session/).waitFor();
    await dialog.getByRole("button", { name: "Keep read-only mode", exact: true }).click();
    console.log(JSON.stringify({ size, before, after, shiftPx: after.mainTop - before.mainTop, permissionDialog: "preserved" }));
    await context.close();
  }
  console.log("PASS: read-only banner appearance has no mobile layout shift at 390x844 for small and large preferences");
} finally {
  await browser.close();
}
