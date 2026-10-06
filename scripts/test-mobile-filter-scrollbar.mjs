// Mobile filter strip regression. Uses an isolated demo project and performs no writes.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.SCOTTY_TEST_URL;
assert.ok(base, 'Set SCOTTY_TEST_URL to an isolated demo server');

const bead = {
  id: 'filter-mobile-a',
  title: 'Mobile filter fixture',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  assignee: 'reviewer',
  labels: ['mobile', 'filter-fixture'],
  dependencies: [],
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};
const beads = [bead];
const browser = await chromium.launch();
let releaseBeads;
const responseGate = new Promise(resolve => { releaseBeads = resolve; });
let writes = 0;

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 1,
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(60000);
  page.on('pageerror', error => { throw error; });
  await page.route('**/api/p/demo/beads/stream', route => route.abort());
  await page.route('**/api/p/demo/beads', async route => {
    if (route.request().method() !== 'GET') {
      writes += 1;
      return route.fulfill({ json: {} });
    }
    await responseGate;
    return route.fulfill({
      json: {
        beads,
        meta: {
          kind: 'demo',
          humanActor: 'reviewer',
          humanAllowlist: ['reviewer'],
          pollIntervalMs: 300000,
        },
      },
    });
  });

  await page.goto(`${base}/p/demo`, { waitUntil: 'domcontentloaded' });
  // Match the existing mobile shell used by the running candidate: this
  // upstream base still renders the desktop sidebar at 390px; the separately
  // reviewed mobile-navigation change hides it. Navigation is not tested here.
  await page.addStyleTag({
    content: '@media (max-width: 767px) { aside { display: none !important; } }',
  });
  const strip = page.getByRole('group', { name: 'Bead filters' });
  await strip.waitFor();
  const inspect = (target = strip) => target.evaluate(element => {
    const style = getComputedStyle(element);
    const webkit = getComputedStyle(element, '::-webkit-scrollbar');
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      scrollLeft: element.scrollLeft,
      tabIndex: element.tabIndex,
      scrollbarWidth: style.scrollbarWidth,
      webkitScrollbarDisplay: webkit.display,
    };
  });
  const assertHidden = async (stage, target = strip) => {
    const state = await inspect(target);
    assert.ok(state.scrollWidth > state.clientWidth, `${stage}: strip remains horizontally scrollable`);
    assert.equal(state.scrollbarWidth, 'none', `${stage}: standard scrollbar is hidden`);
    assert.equal(state.webkitScrollbarDisplay, 'none', `${stage}: WebKit scrollbar is hidden`);
    assert.equal(state.tabIndex, 0, `${stage}: strip is keyboard-focusable`);
    return state;
  };

  const loading = await assertHidden('loading / initial render');
  assert.equal(loading.scrollLeft, 0);
  await page.screenshot({ path: '/tmp/scotty-filter-scrollbar-initial.png' });

  releaseBeads();
  await page.getByRole('button', { name: 'Labels', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Assignee', exact: true }).waitFor();
  const loaded = await assertHidden('loaded render');
  assert.equal(loaded.scrollLeft, 0);

  const box = await strip.boundingBox();
  assert.ok(box);
  const x = Math.round(box.x + box.width * 0.72);
  const y = Math.round(box.y + box.height / 2);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ id: 1, x, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ id: 1, x: x - 80, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ id: 1, x: x - 170, y, radiusX: 2, radiusY: 2, force: 1 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(250);
  const touched = await assertHidden('after touch scroll');
  assert.ok(touched.scrollLeft > 0, 'horizontal touch gesture scrolls the filter controls');
  await page.screenshot({ path: '/tmp/scotty-filter-scrollbar-after-touch.png' });

  const buttons = strip.getByRole('button');
  const buttonCount = await buttons.count();
  assert.ok(buttonCount >= 6, 'all filter chips are present as keyboard controls');
  await strip.evaluate(element => { element.scrollLeft = 0; });
  await strip.focus();
  for (let i = 0; i < buttonCount; i += 1) {
    await page.keyboard.press('Tab');
    assert.equal(
      await strip.evaluate(element => element.contains(document.activeElement)),
      true,
      'Tab reaches each filter control without leaving the strip',
    );
  }
  const keyboard = await assertHidden('after keyboard navigation');
  assert.ok(keyboard.scrollLeft > 0, 'keyboard focus scrolls later filter chips into view');

  await page.goto(`${base}/p/demo?view=list`, { waitUntil: 'domcontentloaded' });
  await page.addStyleTag({
    content: '@media (max-width: 767px) { aside { display: none !important; } }',
  });
  await page.getByRole('heading', { name: 'List', exact: true }).waitFor();
  const listStrip = page.getByRole('group', { name: 'Bead filters' });
  await listStrip.waitFor();
  await page.getByRole('button', { name: 'Labels', exact: true }).waitFor();
  const listLoaded = await assertHidden('List initial render', listStrip);

  assert.equal(writes, 0, 'the test does not mutate project data');
  console.log(JSON.stringify({ loading, loaded, touched, keyboard, listLoaded, keyboardButtons: buttonCount, writes }));
  await cdp.detach();
  await context.close();
} finally {
  releaseBeads?.();
  await browser.close();
}
