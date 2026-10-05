import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, "Set SCOTTY_TEST_URL to an isolated demo server");

const bead = (id, title, status = "open") => ({
  id,
  title,
  status,
  issue_type: "task",
  priority: 2,
  labels: [],
  dependencies: [],
  created_by: "touch-test",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
});
const fillers = Array.from({ length: 15 }, (_, index) =>
  bead("touch-filler-" + (index + 1), "Touch scroll filler " + (index + 1)),
);
const beads = [
  bead("touch-a", "Touch scroll fixture A", "deferred"),
  bead("touch-b", "Touch scroll fixture B", "deferred"),
  ...fillers,
  bead("touch-progress", "Touch scroll fixture in progress", "in_progress"),
];
const writes = [];

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/p/demo/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith("/beads/stream")) return route.abort();
    if (path.endsWith("/order")) {
      if (request.method() === "GET") return route.fulfill({ json: { orders: {} } });
      writes.push({ kind: "order", body: request.postDataJSON() });
      return route.fulfill({ json: { orders: {} } });
    }
    if (path.endsWith("/beads")) {
      return route.fulfill({
        json: {
          beads,
          meta: {
            kind: "demo",
            humanActor: "touch-test",
            humanAllowlist: ["touch-test"],
            pollIntervalMs: 300000,
          },
        },
      });
    }
    if (path.endsWith("/status")) {
      const id = path.split("/").at(-2);
      const body = request.postDataJSON();
      writes.push({ kind: "status", id, body });
      return route.fulfill({ json: beads.find((candidate) => candidate.id === id) ?? {} });
    }
    const id = path.split("/").at(-1);
    return route.fulfill({ json: beads.find((candidate) => candidate.id === id) ?? {} });
  });

  await page.goto(base + "/p/demo");
  await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
  const unlock = await context.request.put(base + "/api/viewer-mode", {
    data: { readOnly: false },
  });
  assert.equal(unlock.status(), 200, "only the isolated demo viewer is unlocked");
  await page.reload();
  const card = (id) => page.locator('[data-keyboard-bead-id="' + id + '"]');
  await card("touch-a").waitFor({ state: "visible" });

  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  await page.evaluate(() => {
    window.__touchEvents = [];
    for (const type of ["touchstart", "touchmove", "touchend"]) {
      document.addEventListener(
        type,
        (event) =>
          window.__touchEvents.push({
            type,
            trusted: event.isTrusted,
            beadId: event.target.closest("[data-keyboard-bead-id]")?.getAttribute("data-keyboard-bead-id") ?? null,
          }),
        true,
      );
    }
  });

  const point = (x, y) => ({
    x,
    y,
    id: 1,
    radiusX: 2,
    radiusY: 2,
    force: 0.5,
  });
  const sendTouch = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [point(x, y)],
    });
  const gesture = async (start, end, holdMs = 0) => {
    await sendTouch("touchStart", start.x, start.y);
    if (holdMs) await page.waitForTimeout(holdMs);
    for (let step = 1; step <= 6; step += 1) {
      const progress = step / 6;
      await sendTouch(
        "touchMove",
        start.x + (end.x - start.x) * progress,
        start.y + (end.y - start.y) * progress,
      );
      await page.waitForTimeout(30);
    }
    await sendTouch("touchEnd", end.x, end.y);
    await page.waitForTimeout(150);
  };

  const boardScroller = () =>
    page.evaluate(() => {
      const element = [...document.querySelectorAll(".bd-scroll")]
        .filter(
          (candidate) =>
            candidate.scrollWidth > candidate.clientWidth + 10 &&
            getComputedStyle(candidate).overflowX === "auto",
        )
        .sort((left, right) => right.clientHeight - left.clientHeight)[0];
      return element
        ? { left: element.scrollLeft, width: element.clientWidth, fullWidth: element.scrollWidth }
        : null;
    });
  const center = async (locator) => {
    const box = await locator.boundingBox();
    assert.ok(box, "touch target must exist");
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const left = Math.max(0, box.x);
    const right = Math.min(viewport.width, box.x + box.width);
    const top = Math.max(0, box.y);
    const bottom = Math.min(viewport.height, box.y + box.height);
    assert.ok(right > left && bottom > top, "touch target must intersect the viewport");
    return { x: left + (right - left) / 2, y: top + (bottom - top) / 2 };
  };

  const beforeBoard = await boardScroller();
  assert.ok(beforeBoard && beforeBoard.fullWidth > beforeBoard.width, "the mobile Board has a horizontal scroll range");
  const boardStart = await center(card("touch-a"));
  console.log("BOARD_START " + JSON.stringify(boardStart));
  const boardTarget = await card("touch-a").evaluate((element) => ({
    rect: (() => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })(),
    touchAction: getComputedStyle(element).touchAction,
    ancestors: [element.parentElement, element.parentElement?.parentElement].map((ancestor) => ({
      className: String(ancestor?.className ?? ""),
      overflowX: ancestor ? getComputedStyle(ancestor).overflowX : "",
      overflowY: ancestor ? getComputedStyle(ancestor).overflowY : "",
    })),
  }));
  await gesture(boardStart, { x: boardStart.x - 110, y: boardStart.y });
  const afterBoard = await boardScroller();

  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.getByRole("heading", { name: "List", exact: true }).waitFor();
  await card("touch-a").waitFor({ state: "visible" });
  const listScroller = () =>
    page.evaluate(() => {
      const element = [...document.querySelectorAll(".bd-scroll")]
        .filter(
          (candidate) =>
            candidate.scrollHeight > candidate.clientHeight + 10 &&
            getComputedStyle(candidate).overflowY === "auto",
        )
        .sort((left, right) => right.clientHeight - left.clientHeight)[0];
      return element
        ? { top: element.scrollTop, height: element.clientHeight, fullHeight: element.scrollHeight }
        : null;
    });
  const beforeList = await listScroller();
  assert.ok(beforeList && beforeList.fullHeight > beforeList.height, "the mobile List has a vertical scroll range");
  const listStart = await center(card("touch-a"));
  await gesture(listStart, { x: listStart.x, y: listStart.y - 110 });
  const afterList = await listScroller();

  const trusted = await page.evaluate(
    () => window.__touchEvents.length > 0 && window.__touchEvents.every((event) => event.trusted),
  );
  const scrollEvidence = {
    viewport: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    board: { before: beforeBoard.left, after: afterBoard?.left, range: beforeBoard.fullWidth - beforeBoard.width },
    boardTarget,
    list: { before: beforeList.top, after: afterList?.top, range: beforeList.fullHeight - beforeList.height },
    allTouchEventsTrusted: trusted,
    observedTouchTargets: await page.evaluate(() => window.__touchEvents.slice(0, 12)),
  };
  console.log("SCROLL_EVIDENCE " + JSON.stringify(scrollEvidence));
  const scrollFailures = [];
  if (!(afterBoard && afterBoard.left > beforeBoard.left)) scrollFailures.push("horizontal Board swipe did not scroll");
  if (!(afterList && afterList.top > beforeList.top)) scrollFailures.push("vertical List swipe did not scroll");
  if (!trusted) scrollFailures.push("touch input was not trusted");
  assert.deepEqual(scrollFailures, [], scrollFailures.join("; "));

  await page.evaluate(() => {
    const element = [...document.querySelectorAll(".bd-scroll")]
      .filter((candidate) => candidate.scrollHeight > candidate.clientHeight + 10)
      .sort((left, right) => right.clientHeight - left.clientHeight)[0];
    if (element) element.scrollTop = 0;
  });
  const listHandleA = page.getByRole("button", { name: "Reorder touch-a", exact: true });
  const listHandleB = page.getByRole("button", { name: "Reorder touch-b", exact: true });
  const listRowA = await card("touch-a").boundingBox();
  const listRowB = await card("touch-b").boundingBox();
  assert.ok(listRowA && listRowB && listRowA.y < listRowB.y, "fixture A starts above B in List");
  const listOrderWritesBefore = writes.filter((write) => write.kind === "order").length;
  await gesture(await center(listHandleA), await center(listHandleB), 300);
  const listOrderWrite = writes.filter((write) => write.kind === "order").at(-1);
  assert.ok(listOrderWritesBefore < writes.filter((write) => write.kind === "order").length, "List drag submits an order write");
  assert.ok(listOrderWrite?.body?.ids, "List order write includes the resulting ID order");
  assert.ok(
    listOrderWrite.body.ids.indexOf("touch-b") < listOrderWrite.body.ids.indexOf("touch-a"),
    "List order payload places the dragged A row after its B target",
  );
  console.log("LIST_ORDER_EVIDENCE " + JSON.stringify({
    columnId: listOrderWrite.body.columnId,
    indexB: listOrderWrite.body.ids.indexOf("touch-b"),
    indexA: listOrderWrite.body.ids.indexOf("touch-a"),
  }));
  console.log("PASS: a deliberate long-press trusted touch drag on the List handle reorders a row");

  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("heading", { name: "Board", exact: true }).waitFor();
  await page.evaluate(() => {
    const element = [...document.querySelectorAll(".bd-scroll")]
      .filter((candidate) => candidate.scrollWidth > candidate.clientWidth + 10)
      .sort((left, right) => right.clientHeight - left.clientHeight)[0];
    if (element) element.scrollLeft = 0;
  });
  const tapPoint = await center(card("touch-a"));
  await sendTouch("touchStart", tapPoint.x, tapPoint.y);
  await page.waitForTimeout(60);
  await sendTouch("touchEnd", tapPoint.x, tapPoint.y);
  await page.getByRole("dialog").getByText("Touch scroll fixture A", { exact: true }).waitFor();
  console.log("PASS: a short trusted touch tap opens the bead detail drawer");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });

  await page.getByLabel("Sort board cards").selectOption("manual");
  const cardA = await card("touch-a").boundingBox();
  const cardB = await card("touch-b").boundingBox();
  assert.ok(cardA && cardB, "both reorder cards must exist");
  const pointA = await center(card("touch-a"));
  const pointB = await center(card("touch-b"));
  assert.notEqual(cardA.y, cardB.y, "fixture cards occupy distinct Board ranks");
  const sourceId = cardA.y < cardB.y ? "touch-a" : "touch-b";
  const destinationId = sourceId === "touch-a" ? "touch-b" : "touch-a";
  const source = cardA.y < cardB.y ? pointA : pointB;
  const destination = cardA.y < cardB.y ? pointB : pointA;
  const orderWritesBefore = writes.filter((write) => write.kind === "order").length;
  await gesture(source, destination, 300);
  const boardOrderWrite = writes.filter((write) => write.kind === "order").at(-1);
  assert.ok(orderWritesBefore < writes.filter((write) => write.kind === "order").length, "Board drag submits an order write");
  assert.ok(boardOrderWrite?.body?.ids, "Board order write includes the resulting ID order");
  assert.ok(
    boardOrderWrite.body.ids.indexOf(destinationId) < boardOrderWrite.body.ids.indexOf(sourceId),
    "Board order payload places the dragged card after its target",
  );
  console.log("BOARD_ORDER_EVIDENCE " + JSON.stringify({
    columnId: boardOrderWrite.body.columnId,
    draggedId: sourceId,
    targetId: destinationId,
    targetIndex: boardOrderWrite.body.ids.indexOf(destinationId),
    draggedIndex: boardOrderWrite.body.ids.indexOf(sourceId),
  }));
  console.log("PASS: a deliberate long-press trusted touch drag reorders a Board card");

  assert.deepEqual(errors, [], "the isolated page has no runtime errors");
  await cdp.detach();
  await context.close();
} finally {
  await browser.close();
}
