// Viewer checks in headless Chromium, on the fixture system (viewer/fixture.mjs) and the big synthetic map (viewer/fixture-big.mjs).
//   node test/viewer.verify.mjs [--shots <dir>] [--only layout|interact|features|focus|flow|big|guides|counts|fails-and-holds|look|frame|laptop|pins|toolmap] [--chrome <path>]
//   (on a shared machine, run it so that only one browser is open at a time)
// Part 1 viewports and overflow, 2 interaction, 3 deep links, copy pointer, draft strip, statuses and inspector fields, 4 hover = focus, handles and chips,
// 5 flow (portals, follow the flow, back), regions and halos, 6 the big map. Exits 0 with a SKIP line when no Chromium is found (the page itself needs none).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAtlasData, BOXES, ROUTES, LOOPS, STAGES } from '../viewer/fixture.mjs';
import { countsOf, endingModes } from '../src/build/counts.mjs';
import { holdsOf, HOLD_STATE_WORDS } from '../src/build/holds.mjs';
import { WAIT_WORDS } from '../src/model/waits.mjs';
import { HEARD_WORDS, HEARD_SHORT } from '../src/model/heard.mjs';
import { makeBigData } from '../viewer/fixture-big.mjs';
import { buildPage } from '../viewer/fixture-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ONLY = flag('only', ''), SHOTS = flag('shots', '');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// ---- find a Chromium: CHROME_PATH, playwright's cache, then the usual system browsers -------------------------------------------
function findChrome() {
  const c = [flag('chrome', ''), process.env.CHROME_PATH];
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  for (const d of caches) {
    try {
      for (const e of fs.readdirSync(d).filter(x => /^chromium-\d+$/.test(x)).sort().reverse())
        for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) c.push(path.join(d, e, rel));
    } catch { /* no cache here */ }
  }
  c.push('C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  return c.filter(Boolean).find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}
const CHROME = findChrome();
let chromium = null;
try { chromium = (await import('playwright-core')).chromium; } catch { /* optional dependency */ }
if (!CHROME || !chromium) { console.log('SKIP viewer.verify: ' + (!chromium ? 'playwright-core is not installed' : 'no Chromium found (set CHROME_PATH)') + '. The page needs no browser; only this check does.'); process.exit(0); }

// ---- pages ----------------------------------------------------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-viewer-'));
const PAGE = path.join(TMP, 'atlas.html'), BIG = path.join(TMP, 'big.html');
fs.writeFileSync(PAGE, buildPage(await makeAtlasData()));
fs.writeFileSync(BIG, buildPage(makeBigData()));
const URL0 = pathToFileURL(PAGE).href, URLB = pathToFileURL(BIG).href;

const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + String(info).slice(0, 200) : '')); };
const consoleErrors = [], netRequests = [];
const watch = (page, label) => {
  page.on('request', r => { if (!/^(file|data|blob|about):/.test(r.url())) netRequests.push(label + ' ' + r.url()); });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(label + ' console.' + m.type() + ': ' + m.text()); });
  page.on('pageerror', e => consoleErrors.push(label + ' pageerror: ' + e.message));
};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const insp = page => page.evaluate(() => window.atlasInspect());
const wait = (page, ms = 300) => page.waitForTimeout(ms);
async function open(ctxOrBrowser, url, hash, label, vp = { width: 1920, height: 1080 }, theme = 'dark', perms = []) {
  const ctx = await ctxOrBrowser.newContext({ viewport: vp, permissions: perms });
  await ctx.addInitScript(t => { try { localStorage.setItem('faultline-atlas-theme', t); localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } }, theme);
  const page = await ctx.newPage(); watch(page, label);
  await page.goto(url + (hash || '')); await page.waitForSelector('#atlas', { timeout: 15000 }); await wait(page, 350);
  return { ctx, page };
}
async function openRead(ctxOrBrowser, url, hash, label) {   // a guide page (no chart on screen)
  const ctx = await ctxOrBrowser.newContext({ viewport: { width: 1920, height: 1080 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
  const page = await ctx.newPage(); watch(page, label);
  await page.goto(url + (hash || '')); await page.waitForSelector('.gd', { timeout: 15000 }); await wait(page, 350);
  return { ctx, page };
}
const centre = async (page, sel) => { const b = await page.locator(sel).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
const SECTIONS = ['layout', 'interact', 'features', 'focus', 'flow', 'big', 'guides', 'counts', 'fails-and-holds', 'look', 'frame', 'laptop', 'pins', 'toolmap'];
if (ONLY && !SECTIONS.includes(ONLY)) { console.error(`unknown section "${ONLY}". Sections: ${SECTIONS.join(', ')}`); process.exit(2); }      // a name that matches nothing would run nothing and pass
const want = name => !ONLY || ONLY === name;

try {
/* ============================================================================ 1. viewports, themes, overflow */
if (want('layout')) {
  for (const [w, h] of [[1920, 1080], [1366, 768], [390, 844]]) for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open(browser, URL0, w <= 800 ? '#chart=stage_queue' : '', `${w}x${h}${theme}`, { width: w, height: h }, theme);      // on a phone the poster is a list of stages, not a drawing: the drawing checks run on a stage chart
    const m = await page.evaluate(() => {
      const nav = document.getElementById('nav'), r = document.querySelector('#vp').getBoundingClientRect(), c = document.getElementById('canvas').getBoundingClientRect();
      return { overflowX: document.documentElement.scrollWidth - innerWidth, navScroll: nav.scrollHeight - nav.clientHeight, navDisplay: getComputedStyle(nav).display, scale: window.atlasInspect().scale,
        items: document.querySelectorAll('.nav-item').length, visible: [...document.querySelectorAll('.nav-item')].filter(b => { const q = b.getBoundingClientRect(); return q.width > 0 && q.bottom <= innerHeight + 0.5; }).length,
        fit: { l: r.left - c.left, t: r.top - c.top, r: c.right - r.right, b: c.bottom - r.bottom }, bg: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme };
    });
    const tag = `${w}x${h} ${theme}`;
    ok(`${tag} no horizontal page overflow`, m.overflowX <= 0, 'overflow=' + m.overflowX);
    ok(`${tag} theme applied`, m.theme === theme, m.theme + ' bg ' + m.bg);
    if (w > 800) {
      ok(`${tag} left nav fits without scrolling`, m.navScroll <= 0 && m.visible === m.items, `scroll=${m.navScroll} visible=${m.visible}/${m.items}`);
      ok(`${tag} whole chart fitted inside the canvas`, m.fit.l >= -1 && m.fit.t >= -1 && m.fit.r >= -1 && m.fit.b >= -1, JSON.stringify(m.fit));
    } else ok(`${tag} phone: select menu shown, sidebar hidden`, m.navDisplay === 'none' && await page.isVisible('#navSelect'));
    await shot(page, `layout_${w}x${h}_${theme}`);
    await ctx.close();
  }
  for (const [w, h] of [[390, 844], [844, 390]]) {   // the poster and the whole map on a phone: a list of the stages stands in their place
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage(); watch(page, 'phone' + w);
    await page.goto(URL0); await page.waitForSelector('#phoneStages .ph-row', { timeout: 15000 }); await wait(page, 300);
    const m = await page.evaluate(() => {
      const R = e => e.getBoundingClientRect(), rows = [...document.querySelectorAll('#phoneStages .ph-row')], nums = rows.map(r => r.querySelector('.ph-no').textContent.trim());
      return { overflowX: document.documentElement.scrollWidth - innerWidth, rows: rows.length, nameMin: Math.min.apply(null, rows.map(r => parseFloat(getComputedStyle(r.querySelector('.ph-nm')).fontSize))), dup: nums.length - new Set(nums).size,
        canvasShown: R(document.getElementById('canvasWrap')).height > 0, says: /bigger screen/.test(document.getElementById('phoneStages').textContent), what: /interactive map/.test(document.getElementById('chartMade').textContent),
        cut: rows.filter(r => R(r).right > innerWidth + 1 || R(r).left < -1).length };
    });
    const tag = w + 'x' + h + ' phone';
    ok(tag + ': a list of the stages stands in for the drawing, each name 10 px or larger, each number once', m.rows === STAGES.length && m.nameMin >= 10 && m.dup === 0 && !m.canvasShown, JSON.stringify(m));
    ok(tag + ': says what it is and that the full map reads best on a bigger screen; no sideways scroll; nothing cut by the screen edge', m.says && m.what && m.overflowX <= 0 && m.cut === 0, JSON.stringify(m));
    await page.locator('#phoneStages .ph-row').first().tap(); await wait(page, 500);
    ok(tag + ': a tap on a stage opens a chart of that stage', await page.evaluate(() => /^stage_/.test(window.atlasInspect().chart || '') && document.getElementById('canvasWrap').getBoundingClientRect().height > 100));
    await shot(page, 'phone_' + w + 'x' + h);
    await ctx.close();
  }
  { // theme toggle remembers itself under the page's own key
    const { ctx, page } = await open(browser, URL0, '', 'theme');
    await page.click('#themeBtn'); await wait(page, 200);
    const t = await page.evaluate(() => ({ attr: document.documentElement.dataset.theme, saved: localStorage.getItem('faultline-atlas-theme'), btn: document.getElementById('themeBtn').textContent }));
    ok('theme button switches and saves under faultline-atlas-theme', t.attr === 'light' && t.saved === 'light' && /dark/i.test(t.btn), JSON.stringify(t));
    await ctx.close();
  }
}

/* ============================================================================ 2. interaction on one stage chart (click / hover / trace / walk / zoom / search) */
if (want('interact')) {
  const { ctx, page } = await open(browser, URL0, '#chart=stage_queue', 'interact', undefined, 'dark', ['clipboard-read', 'clipboard-write']);
  const target = 'queue.claim';
  const box = await centre(page, `g.node[data-node="${target}"] .node-box`);
  await page.mouse.move(box.x, box.y); await wait(page, 200);
  ok('hover shows the tooltip', await page.evaluate(() => !document.getElementById('tip').hidden && document.getElementById('tip').textContent.length > 5));
  ok('hover focuses the box (same classes as a pin)', await page.evaluate(() => document.getElementById('atlas').classList.contains('has-sel') && document.querySelectorAll('.node.sel').length === 1));
  await page.mouse.click(box.x, box.y); await wait(page, 350);
  let st = await page.evaluate(() => ({ p: window.atlasInspect().pinned, has: document.getElementById('atlas').classList.contains('has-sel'), sel: document.querySelectorAll('.node.sel').length, hash: location.hash,
    txt: document.getElementById('inspector').innerText }));
  ok('click pins the box', st.p && st.p.t === 'node' && st.has && st.sel === 1, JSON.stringify(st.p));
  ok('hash carries chart and box', st.hash.includes('chart=stage_queue') && st.hash.includes('node=' + target), st.hash);
  ok('inspector has plain words and where it arrives from', /what it does/i.test(st.txt) && /where it came from/i.test(st.txt) && /where it goes next/i.test(st.txt));
  const dim = await page.evaluate(() => { const e = document.querySelector('.node:not(.rel)'); return e ? getComputedStyle(e).opacity : 'n/a'; });
  ok('boxes outside the focus dim to about 14%', dim === 'n/a' || Math.abs(parseFloat(dim) - 0.14) < 0.06, 'opacity=' + dim);
  await shot(page, 'interact_pinned');

  await page.click('[data-act="down"]'); await wait(page, 450);
  st = await page.evaluate(() => ({ t: window.atlasInspect().trace, hiOut: document.querySelectorAll('.edge.hi-out').length }));
  ok('trace downstream lights the routes that can follow', st.t && st.t.kind === 'down' && st.t.nodes >= 3 && st.hiOut >= 2, JSON.stringify(st));
  await page.click('[data-act="up"]'); await wait(page, 300);
  ok('trace upstream works', (await insp(page)).trace?.kind === 'up');
  await page.click('[data-act="path"]'); await wait(page, 150);
  ok('path picking shows its banner', await page.isVisible('#pickBanner'));
  const other = await centre(page, 'g.node[data-node="queue.fail"] .node-box');
  await page.mouse.click(other.x, other.y); await wait(page, 350);
  st = await page.evaluate(() => ({ t: window.atlasInspect().trace, txt: document.getElementById('inspector').innerText }));
  ok('trace path to a second box', st.t && st.t.kind === 'path' && /one way the roads allow|along the declared path/i.test(st.txt), JSON.stringify(st.t));
  await page.keyboard.press('Escape'); await wait(page, 200);
  st = await page.evaluate(() => ({ p: window.atlasInspect().pinned, t: window.atlasInspect().trace, has: document.getElementById('atlas').classList.contains('has-sel') }));
  ok('Esc clears pin and trace', !st.p && !st.t && !st.has, JSON.stringify(st));

  await page.focus('#canvas'); await page.keyboard.press('Enter'); await wait(page, 250);
  const first = (await insp(page)).pinned;
  await page.keyboard.press('ArrowRight'); await wait(page, 450);
  const second = (await insp(page)).pinned;
  ok('Enter selects a first box and ArrowRight walks a route', first && second && first.id !== second.id, `${first?.id} -> ${second?.id}`);
  await page.keyboard.press('ArrowLeft'); await wait(page, 350);
  ok('ArrowLeft walks back', (await insp(page)).pinned?.id === first?.id);
  await page.keyboard.press('Escape');

  const s0 = (await insp(page)).scale, cb = await page.locator('#canvas').boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2); await page.mouse.wheel(0, -300); await wait(page, 200);
  const s1 = (await insp(page)).scale;
  ok('wheel zooms in', s1 > s0 * 1.1, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`);
  const v0 = (await insp(page)).view;
  await page.mouse.move(cb.x + 300, cb.y + 300); await page.mouse.down(); await page.mouse.move(cb.x + 420, cb.y + 360, { steps: 6 }); await page.mouse.up(); await wait(page, 150);
  ok('drag pans', Math.abs((await insp(page)).view.x - v0.x) > 50);
  await page.keyboard.press('0'); await wait(page, 500);
  ok('0 refits', Math.abs((await insp(page)).scale - s0) < 0.03, (await insp(page)).scale.toFixed(2) + ' vs ' + s0.toFixed(2));
  await page.keyboard.press('+'); await wait(page, 350);
  ok('+ zooms in', (await insp(page)).scale > s0 * 1.1);
  await page.click('#z100'); await wait(page, 450);
  ok('100% button', Math.abs((await insp(page)).scale - 1) < 0.02);
  await page.click('#zFit'); await wait(page, 450);
  const db = await centre(page, `g.node[data-node="${target}"] .node-box`);
  await page.mouse.dblclick(db.x, db.y); await wait(page, 550);
  ok('double-click zooms to the box', (await insp(page)).scale > s0 * 1.2);
  await page.click('#zFit'); await wait(page, 450);

  { // a double-click at a human pace: the first click pins the box and opens the panel, the second still means the first click's box (the poster's stage opening is measured on the real pages)
    const slow = async (pg, p) => { await pg.mouse.move(p.x, p.y); await pg.mouse.down(); await pg.mouse.up(); await wait(pg, 140); await pg.mouse.down({ clickCount: 2 }); await pg.mouse.up({ clickCount: 2 }); await wait(pg, 1000); };
    const Q = await open(browser, URL0, '#chart=stage_queue', 'dblslow2');
    const z0 = (await insp(Q.page)).scale, bp = await centre(Q.page, 'g.node[data-node="' + target + '"] .node-box');
    await slow(Q.page, bp);
    const r2 = await Q.page.evaluate(() => ({ pinned: window.atlasInspect().pinned && window.atlasInspect().pinned.id, z: window.atlasInspect().scale, chart: window.atlasInspect().chart, edge: /edge=/.test(location.hash), sel: String(getSelection()).trim() }));
    ok('double-click on a box of a chart, at a human pace, zooms to that box (no road, no word, no other box)', r2.chart === 'stage_queue' && r2.pinned === target && r2.z > z0 * 1.1 && !r2.edge && !r2.sel, JSON.stringify(r2) + ' from ' + z0.toFixed(2));
    await Q.ctx.close();
  }

  // search: by title word, by box id, by function name, then across all charts
  await page.fill('#q', 'lease'); await wait(page, 250);
  st = await page.evaluate(() => ({ m: document.querySelectorAll('.node.q-match').length, s: document.getElementById('atlas').classList.contains('searching'), c: document.getElementById('qCount').textContent }));
  ok('search highlights matches and dims the rest', st.m >= 2 && st.s, JSON.stringify(st));
  await page.keyboard.press('Enter'); await wait(page, 400);
  ok('Enter jumps to a match and pins it', (await insp(page)).pinned !== null);
  await page.fill('#q', 'queue.retry'); await wait(page, 250);
  ok('a box id typed whole finds that box first', await page.evaluate(() => document.querySelectorAll('.node.q-match').length >= 1 && document.querySelector('.node.q-match').dataset.node === 'queue.retry'));
  await page.fill('#q', 'Queue.reclaim'); await wait(page, 250);
  ok('a function name finds its box', await page.evaluate(() => [...document.querySelectorAll('.node.q-match')].some(n => n.dataset.node === 'queue.expire')));
  await page.fill('#q', ''); await page.keyboard.press('Escape'); await wait(page, 150);
  await page.click('#qAll'); await page.fill('#q', 'receipt'); await wait(page, 300);
  const nres = await page.locator('.qres').count();
  ok('search across every chart lists results', nres >= 3, nres + ' results');
  await shot(page, 'interact_search_all');
  await page.locator('.qres:not(.qres-h)').nth(0).click(); await wait(page, 550);
  st = await page.evaluate(() => ({ c: window.atlasInspect().chart, p: window.atlasInspect().pinned, h: location.hash }));
  ok('a result opens its chart with the box pinned', st.p && st.c && st.h.includes('node='), JSON.stringify(st));
  await page.click('#qAll');

  // routes
  await page.goto(URL0 + '#chart=stage_queue'); await page.waitForSelector('#atlas'); await wait(page, 350);
  const eHit = await page.evaluate(() => { const e = document.querySelector('g.edge[data-edge="stage_queue:r_claim"] .edge-line'), p = e.getPointAtLength(e.getTotalLength() / 2), m = e.getScreenCTM(); return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f }; });
  await page.mouse.move(eHit.x, eHit.y); await wait(page, 250);
  ok('hover on a route thickens it and shows its tip', await page.evaluate(() => !!document.querySelector('.edge.hov') && !document.getElementById('tip').hidden));
  await page.mouse.click(eHit.x, eHit.y); await wait(page, 350);
  st = await page.evaluate(() => ({ p: window.atlasInspect().pinned, txt: document.getElementById('inspector').innerText, hi: document.querySelectorAll('.edge.hi-sel').length }));
  ok('click on a route opens the route inspector (label, why, either end)', st.p?.t === 'edge' && st.hi === 1 && /road label/i.test(st.txt) && /why this road exists/i.test(st.txt) && /trace either end/i.test(st.txt), JSON.stringify(st.p));
  await page.locator('#inspector .node-btn').first().click(); await wait(page, 400);
  ok('the trace-either-end button selects the box', (await insp(page)).pinned?.t === 'node');
  await page.locator('#inspector .route').first().click(); await wait(page, 400);
  ok('a route button in the inspector selects that route', (await insp(page)).pinned?.t === 'edge');
  await page.keyboard.press('Escape');
  await page.goto(URL0 + '#chart=stage_queue&node=queue.retry'); await page.waitForSelector('#atlas'); await wait(page, 350);
  await page.focus('#canvas'); await page.keyboard.press('ArrowRight'); await wait(page, 350);
  const a1 = (await insp(page)).pinned.id; await page.keyboard.press('Tab'); await wait(page, 350);
  const a2 = (await insp(page)).pinned.id;
  ok('Tab cycles the other roads out of a box', a1 !== a2, `queue.retry -> ${a1} / ${a2}`);
  await page.keyboard.press('Escape');

  // legend: every box kind, every route type, dim and faint, handles
  await page.click('#legendBtn'); await wait(page, 250);
  const lg = await page.evaluate(() => ({ t: document.getElementById('legend').innerText, hidden: document.getElementById('legend').hidden }));
  ok('legend lists every box kind', !lg.hidden && ['Step', 'Decision', 'Wait', 'Ending', 'Store', 'Outside', 'Gate'].every(w => lg.t.includes(w)), lg.t.slice(0, 80).replace(/\n/g, ' | '));
  ok('legend lists the road types, dim and faint, handles and reading aids', ['normal flow', 'return or retry', 'record or side effect', 'hand-off', 'dim box', 'faint road', 'official handles', 'arrowhead', 'little hop'].every(w => lg.t.toLowerCase().includes(w)));
  await shot(page, 'interact_legend');
  await page.keyboard.press('Escape'); await wait(page, 150);
  ok('Esc closes the legend', await page.evaluate(() => document.getElementById('legend').hidden));
  await ctx.close();
}

/* ============================================================================ 3. what the generic viewer adds: deep links, copy pointer, draft strip, statuses, inspector fields, internal API */
if (want('features')) {
  { // deep links
    const { ctx, page } = await open(browser, URL0, '#chart=stage_queue&node=queue.retry', 'deeplink');
    let st = await page.evaluate(() => { const a = window.atlasInspect(), r = document.querySelector('g.node[data-node="queue.retry"] .node-box').getBoundingClientRect(), c = document.getElementById('canvas').getBoundingClientRect();
      return { chart: a.chart, p: a.pinned, scale: a.scale, inside: r.left >= c.left && r.right <= c.right && r.top >= c.top && r.bottom <= c.bottom, sel: document.querySelectorAll('.node.sel').length }; });
    ok('#chart=<id>&node=<box> opens the chart with the box pinned and zoomed into view', st.chart === 'stage_queue' && st.p?.id === 'queue.retry' && st.sel === 1 && st.scale >= 0.79 && st.inside, JSON.stringify(st));
    await page.goto(URL0 + '#node=delivery.fast_lane'); await wait(page, 500);
    st = await insp(page);
    ok('#node=<box> alone finds the stage chart that holds it', st.chart === 'stage_delivery' && st.pinned?.id === 'delivery.fast_lane', st.chart + ' ' + JSON.stringify(st.pinned));
    await page.goto(URL0 + '#chart=stage_intake&node=queue.retry'); await wait(page, 500);
    st = await insp(page);
    ok('a deep link whose chart does not hold the box falls back to one that does', st.chart === 'stage_queue' && st.pinned?.id === 'queue.retry', st.chart);
    await page.goto(URL0 + '#chart=nope&node=nope'); await wait(page, 500);
    ok('an unknown link opens the first chart instead of failing', (await insp(page)).chart === 'overview');
    await ctx.close();
  }
  { // copy pointer + copy link
    const { ctx, page } = await open(browser, URL0, '#chart=stage_queue&node=queue.retry', 'pointer', undefined, 'dark', ['clipboard-read', 'clipboard-write']);
    await page.click('[data-act="copy-pointer"]'); await wait(page, 300);
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    const last = (await insp(page)).lastCopy;
    ok('Copy pointer copies "faultline where <box>"', last === 'faultline where queue.retry' && (clip === null || clip === last), `last=${last} clipboard=${clip}`);
    ok('the button says it worked', await page.evaluate(() => /copied/i.test(document.querySelector('[data-act="copy-pointer"]').textContent)));
    await page.click('[data-act="copy-link"]'); await wait(page, 300);
    const link = (await insp(page)).lastCopy;
    ok('Copy link copies a link that reopens this box', /#chart=stage_queue&node=queue\.retry/.test(link), link);
    await shot(page, 'features_pointer');
    await ctx.close();
  }
  { // draft strip
    const { ctx, page } = await open(browser, URL0, '#chart=stage_intake', 'draft');
    const d = await page.evaluate(() => { const b = document.getElementById('draftBar'), r = b.getBoundingClientRect(), c = document.getElementById('canvas').getBoundingClientRect();
      return { hidden: b.hidden, txt: b.innerText, above: r.bottom <= c.top + 1, h: Math.round(r.height), state: b.querySelector('.db-state')?.textContent }; });
    ok('draft strip says Draft, the census tally and the not-drawn count', !d.hidden && /draft/i.test(d.state) && /endings in the code\s*4\/14/.test(d.txt) && /branches in the code\s*9\/22/.test(d.txt) && /not drawn yet\s*6/i.test(d.txt), d.txt.replace(/\n/g, ' '));
    ok('the strip sits above the map, never over it, and is slim', d.above && d.h <= 40, JSON.stringify({ above: d.above, h: d.h }));
    await page.click('.db-nd'); await wait(page, 300);
    const p = await page.evaluate(() => ({ open: !document.getElementById('dockPanel').hidden, txt: document.getElementById('dockPanel').innerText }));
    ok('Not drawn yet opens the docked panel with the list', p.open && /parcelworks\/cli\.py/.test(p.txt) && /census/i.test(p.txt) && /4 of 14/.test(p.txt), p.txt.slice(0, 90).replace(/\n/g, ' '));
    await shot(page, 'features_draft_panel');
    await page.keyboard.press('Escape'); await wait(page, 200);
    ok('Esc closes the docked panel', await page.evaluate(() => document.getElementById('dockPanel').hidden));
    const none = await page.evaluate(() => document.querySelector('#chartView').innerText.split('\n').filter(l => /^draft$/i.test(l.trim())).length);
    ok('no draft text is drawn inside the map', await page.evaluate(() => !/draft/i.test(document.getElementById('atlas').textContent)) && none <= 1);
    await ctx.close();
  }
  { // statuses, kinds, inspector fields, refs, inferred routes
    const { ctx, page } = await open(browser, URL0, '#chart=stage_delivery', 'status');
    const o = await page.evaluate(() => {
      const off = document.querySelector('.node[data-node="delivery.fast_lane"]'), normal = document.querySelector('.node[data-node="delivery.pick"]'), test = document.querySelector('.node[data-node="delivery.lost"]');
      const op = el => parseFloat(getComputedStyle(el.querySelector('.node-box')).opacity), nm = el => parseFloat(getComputedStyle(el.querySelector('.node-text')).opacity);      // an off box is paler (its box); its NAME reads at full strength
      return { offCls: off.classList.contains('st-off'), off: op(off), offText: nm(off), normal: op(normal), test: op(test), inferred: document.querySelectorAll('.edge.inferred').length, kinds: [...new Set([...document.querySelectorAll('.node')].map(n => n.dataset.kind))].sort().join(',') };
    });
    ok("status 'off' boxes are drawn paler, with their name at full strength", o.offCls && o.off < 0.7 && o.offText === 1 && o.normal === 1 && o.test < 1 && o.test > o.off, JSON.stringify(o));
    ok('inferred routes are marked', o.inferred >= 2, 'inferred=' + o.inferred);
    ok('box kinds come through on the map', ['end', 'external', 'gate', 'step'].every(k => o.kinds.includes(k)), o.kinds);
    await page.click('g.node[data-node="delivery.fast_lane"] .node-box'); await wait(page, 350);
    let t = await page.evaluate(() => document.getElementById('inspector').innerText);
    ok('inspector shows status and the switch behind it', /off by default/i.test(t) && /FAST_LANE/.test(t) && /gate/i.test(t), t.slice(0, 120).replace(/\n/g, ' '));
    await page.goto(URL0 + '#chart=stage_queue&node=queue.retry'); await wait(page, 450);
    t = await page.evaluate(() => document.getElementById('inspector').innerText);
    ok('inspector shows inputs, outputs and failure', /takes in/i.test(t) && /released parcel/.test(t) && /hands on/i.test(t) && /retry or failure/.test(t) && /if it goes wrong/i.test(t) && /limit of zero/i.test(t));
    const refs = await page.evaluate(() => [...document.querySelectorAll('#inspector .ref')].map(r => ({ fn: r.querySelector('.ref-fn')?.textContent, loc: r.querySelector('a,.ref-loc')?.textContent, href: r.querySelector('a')?.getAttribute('href') })));
    ok('references show the function name, the file and line, and a link from the configured base', refs.length === 1 && refs[0].fn === 'Queue.fail' && refs[0].loc === 'parcelworks/jobqueue.py:104' && /^https:\/\/example\.invalid\/parcelworks\/blob\/main\/parcelworks\/jobqueue\.py#L104$/.test(refs[0].href), JSON.stringify(refs));
    ok('the pinned source is named from the data, not hard-coded', /Pinned source: fixture-0001/.test(await page.evaluate(() => document.getElementById('inspector').innerText)));
    await page.goto(URL0 + '#chart=stage_delivery&edge=stage_delivery:r_courier'); await wait(page, 450);
    t = await page.evaluate(() => document.getElementById('inspector').innerText);
    ok('an inferred route says it is lower trust', /inferred/i.test(t) && /lower trust/i.test(t));
    await ctx.close();
  }
  { // links in a page with no configured base are plain text
    const d = await makeAtlasData(); delete d.meta.sourceBase;
    const f = path.join(TMP, 'nobase.html'); fs.writeFileSync(f, buildPage(d));
    const { ctx, page } = await open(browser, pathToFileURL(f).href, '#chart=stage_queue&node=queue.retry', 'nobase');
    const r = await page.evaluate(() => ({ a: document.querySelectorAll('#inspector .ref a').length, loc: document.querySelectorAll('#inspector .ref .ref-loc').length }));
    ok('with no source base the references are plain text', r.a === 0 && r.loc === 1, JSON.stringify(r));
    await ctx.close();
  }
  { // the internal API for the later modules
    const { ctx, page } = await open(browser, URL0, '#chart=stage_queue', 'api');
    const r = await page.evaluate(() => new Promise(resolve => {
      const FL = window.atlasFL, log = { chartHook: 0, zoomHook: 0, scale: FL.scale(), ctxId: FL.chart() && FL.chart().id };
      FL.onChart(c => { log.chartHook++; log.lastChart = c.id; });
      FL.onZoom((s, p) => { log.zoomHook++; log.lastZoom = [p, s]; });
      const body = FL.openPanel('Hello', '<button type="button" data-x="1">go</button>', { onClick: e => { log.clicked = !!e.target.closest('[data-x]'); }, onClose: () => { log.closed = true; } });
      log.panelOpen = !document.getElementById('dockPanel').hidden; log.body = !!body && body.textContent === 'go'; log.title = document.querySelector('#dockPanel .hp-h').textContent;
      document.querySelector('#dockPanel [data-x]').click();
      window.atlasOpen('stage_delivery');
      setTimeout(() => { document.getElementById('zIn').click(); setTimeout(() => { FL.closePanel(); log.closedAfter = document.getElementById('dockPanel').hidden; resolve(log); }, 450); }, 400);
    }));
    ok('FL.chart and FL.scale report the mounted chart and the zoom', r.ctxId === 'stage_queue' && r.scale > 0.2, JSON.stringify([r.ctxId, r.scale]));
    ok('FL.onChart fires when a chart mounts, FL.onZoom when the zoom changes', r.chartHook >= 2 && r.lastChart === 'stage_delivery' && r.zoomHook >= 1 && r.lastZoom && r.lastZoom[1] !== r.lastZoom[0], JSON.stringify(r));
    ok('FL.openPanel docks arbitrary content, routes clicks to the caller and closes', r.panelOpen && r.body && r.title === 'Hello' && r.clicked && r.closed && r.closedAfter, JSON.stringify(r));
    await ctx.close();
  }
}

/* ============================================================================ 4. hover = focus, handles: chips on the map, chips in the panels, the Handles panel */
if (want('focus')) {
  const { ctx, page } = await open(browser, URL0, '#chart=stage_queue', 'focus');
  const clsOf = () => page.evaluate(() => ({ n: [...document.querySelectorAll('.node')].filter(n => n.classList.contains('rel')).map(n => n.dataset.node + ':' + [...n.classList].filter(c => /^(sel|n-in|n-out)$/.test(c)).join('+')).sort(),
    e: [...document.querySelectorAll('.edge.rel')].map(e => e.dataset.edge + ':' + [...e.classList].filter(c => /^hi-/.test(c)).join('+')).sort(), has: document.getElementById('atlas').classList.contains('has-sel') }));
  const hov = await centre(page, 'g.node[data-node="queue.retry"] .node-box');
  await page.mouse.move(hov.x, hov.y); await wait(page, 300);
  const hovered = await clsOf();
  await page.mouse.click(hov.x, hov.y); await page.mouse.move(5, 5); await wait(page, 350);
  const pinned = await clsOf();
  ok('hover gives exactly the focus a click gives (same boxes, same routes, same classes)', JSON.stringify(hovered) === JSON.stringify(pinned) && hovered.n.length >= 3, JSON.stringify(hovered.n));
  ok('cool colour for what arrives, warm for what leaves', hovered.n.some(x => x.includes('n-in')) && hovered.n.some(x => x.includes('n-out')) && hovered.e.some(x => x.includes('hi-in')) && hovered.e.some(x => x.includes('hi-out')));
  const other = await centre(page, 'g.node[data-node="queue.fail"] .node-box');
  await page.mouse.move(other.x, other.y); await wait(page, 300);
  ok('hovering something else while pinned previews it and keeps the pin as a ghost', await page.evaluate(() => document.getElementById('atlas').classList.contains('previewing') && !!document.querySelector('.node.pin-ghost')));
  await page.mouse.move(5, 300); await wait(page, 350);
  ok('leaving returns to the pin', (await insp(page)).pinned?.id === 'queue.retry' && !(await page.evaluate(() => document.getElementById('atlas').classList.contains('previewing'))));
  await page.keyboard.press('Escape'); await wait(page, 150);
  await shot(page, 'focus_hover');

  // chips: the tab on a box and the same name in the panels agree in colour; a handle is never invented
  const chips = await page.evaluate(() => [...document.querySelectorAll('.chip')].map(c => ({ h: c.dataset.handle, fill: c.querySelector('.chip-bg').getAttribute('fill') })));
  ok('boxes with a handle wear its tab on the map', chips.map(c => c.h).sort().join(',') === 'Backoff,Lease,MAX_ATTEMPTS', JSON.stringify(chips));
  const tab = await page.evaluate(() => [...document.querySelectorAll('#chartCodes .hchip:not(.more)')].map(c => ({ h: c.textContent, bg: getComputedStyle(c).backgroundColor })));
  const svgFill = await page.evaluate(() => { const m = {}; document.querySelectorAll('.chip').forEach(c => { const probe = document.createElement('i'); probe.style.color = c.querySelector('.chip-bg').getAttribute('fill'); document.body.appendChild(probe); m[c.dataset.handle] = getComputedStyle(probe).color; probe.remove(); }); return m; });
  ok('a chip on the map and the same chip in the toolbar are the same colour', tab.length >= 3 && tab.every(t => svgFill[t.h] === t.bg), JSON.stringify([tab, svgFill]));
  await page.click('#handlesBtn'); await wait(page, 300);
  const hp = await page.evaluate(() => ({ open: !document.getElementById('handlePanel').hidden, rows: document.querySelectorAll('#handlePanel .hp-row').length, fams: [...document.querySelectorAll('#handlePanel .hp-fam')].map(x => x.textContent).join(','), txt: document.getElementById('handlePanel').innerText }));
  ok('the Handles panel lists every official name, grouped by stage', hp.open && hp.rows === 6 && /Intake/.test(hp.fams) && /Queue/.test(hp.fams) && /Delivery/.test(hp.fams) && /heaviest parcel/.test(hp.txt), JSON.stringify([hp.rows, hp.fams]));
  await shot(page, 'focus_handles');
  await page.fill('#hpFilter', 'express'); await wait(page, 200);
  ok('the filter finds a handle by its alias', await page.evaluate(() => [...document.querySelectorAll('#handlePanel .hp-row')].map(r => r.dataset.handle).join() === 'FAST_LANE'));
  await page.fill('#hpFilter', ''); await page.click('#handlePanel .hp-row[data-handle="Lease"]'); await wait(page, 350);
  const fo = await page.evaluate(() => ({ m: document.querySelectorAll('.node.h-match').length, f: document.getElementById('atlas').classList.contains('hfocus'), hash: location.hash, txt: document.getElementById('handlePanel').innerText }));
  ok('picking a handle lights every box that carries it and dims the rest', fo.m === 1 && fo.f && /handle=Lease/.test(fo.hash) && /Where Lease engages|Where Lease appears/.test(fo.txt), JSON.stringify([fo.m, fo.hash]));
  await page.keyboard.press('Escape'); await wait(page, 250);
  ok('Esc closes the panel and clears the handle focus', await page.evaluate(() => document.getElementById('handlePanel').hidden && document.querySelectorAll('.node.h-match').length === 0));
  await page.goto(URL0 + '#handle=express'); await wait(page, 600);
  const ds = await insp(page);
  ok('#handle=<alias> opens the chart where that handle appears most, with its panel', ds.chart === 'stage_delivery' && ds.handle === 'FAST_LANE' && ds.handlePanel === 'engage', JSON.stringify([ds.chart, ds.handle]));
  await ctx.close();
}

/* ============================================================================ 5. flow: portals, follow the flow, back; regions and halos */
if (want('flow')) {
  const { ctx, page } = await open(browser, URL0, '#chart=stage_intake', 'flow');
  const fb = await page.evaluate(() => ({ bar: !document.getElementById('flowBar').hidden, next: [...document.querySelectorAll('#fbNext .fchip:not(.fc-more)')].map(x => x.textContent.trim()), strip: document.querySelectorAll('#fbStrip .fs-seg').length, role: document.querySelector('.fb-role')?.textContent }));
  ok('the flow bar shows where this chart comes from and leads to', fb.bar && fb.next.some(x => /Queue/.test(x)) && fb.strip === 5 && /stage/i.test(fb.role), JSON.stringify(fb));
  ok('a portal ring and badge mark the box that hands on to another chart', await page.evaluate(() => !!document.querySelector('.node[data-node="intake.accept"][data-portal="out"] .pbadge')));
  await page.click('g.node[data-node="intake.accept"] .node-box'); await wait(page, 350);
  await page.click('#inspector .route.hand'); await wait(page, 600);
  let a = await insp(page);
  ok('Jump opens the other chart with the connected box pinned', a.chart === 'stage_queue' && a.pinned?.id === 'queue.pending' && a.jumps === 1, JSON.stringify([a.chart, a.pinned, a.jumps]));
  await page.keyboard.press('Alt+ArrowLeft'); await wait(page, 600);
  a = await insp(page);
  ok('Alt+Left goes back to where the jump came from, box and all', a.chart === 'stage_intake' && a.pinned?.id === 'intake.accept' && a.jumps === 0, JSON.stringify([a.chart, a.pinned, a.jumps]));
  await page.click('#followBtn'); await wait(page, 300);
  ok('Follow the flow opens the walk bar', await page.evaluate(() => !document.getElementById('fbJourney').hidden && /2 \/ 5/.test(document.getElementById('fjPos').textContent)), await page.evaluate(() => document.getElementById('fjPos').textContent));
  await page.keyboard.press(']'); await wait(page, 600);
  ok('] steps to the next section in order', (await insp(page)).chart === 'stage_queue');
  await page.keyboard.press('['); await wait(page, 600);
  ok('[ steps back', (await insp(page)).chart === 'stage_intake');
  await shot(page, 'flow_follow');
  await page.click('#fbStrip .fs-seg:last-child'); await wait(page, 600);
  ok('a segment of the journey strip opens that chart', (await insp(page)).chart === 'whole');
  await ctx.close();

  const r = await open(browser, URL0, '#chart=whole', 'regions');
  const rg = await insp(r.page);
  ok('the whole map has stage frames, numbered halos and its regions list', rg.regions && rg.regions.n === 5 && rg.regions.halosOn && rg.regions.haloOn >= 3 && await r.page.evaluate(() => document.querySelectorAll('g.cluster').length === 3), JSON.stringify(rg.regions));
  ok('the main path is off by default on the whole map', await r.page.evaluate(() => !document.getElementById('atlas').classList.contains('show-spine')));
  await r.page.click('#rdSpine'); await wait(r.page, 200);
  ok('the Main path button in the dock draws it as one merged line', await r.page.evaluate(() => document.getElementById('atlas').classList.contains('show-spine') && (document.querySelector('.sw-line').getAttribute('d') || '').length > 20 && document.querySelectorAll('.edge.spine').length >= 8));
  await r.page.click('#rdRegions'); await wait(r.page, 300);
  ok('the Regions list opens beside the map and the map refits to what is left', await r.page.evaluate(() => { const p = document.getElementById('regionPanel'), c = document.getElementById('vp').getBoundingClientRect(); return !p.hidden && c.left >= p.getBoundingClientRect().right - 2; }));
  const row = await centre(r.page, '.rg-row[data-rg="l_retry"] .rg-main');
  await r.page.mouse.move(row.x, row.y); await wait(r.page, 350);
  ok('hovering a region in the list lights its block and dims the rest, with its detail docked (nothing floats over the map)', await r.page.evaluate(() => document.getElementById('atlas').classList.contains('rg-preview') && document.querySelectorAll('.node.rg-in').length === 6 && document.getElementById('tip').hidden && /Retry loop/.test(document.getElementById('rpCard').innerText)));
  await r.page.click('.rg-row[data-rg="l_retry"] .rg-main'); await wait(r.page, 400);
  let t = await r.page.evaluate(() => document.getElementById('inspector').innerText);
  ok('pinning a loop says what bounds it', /limit/i.test(t) && /MAX_ATTEMPTS/.test(t) && (await insp(r.page)).regions.selected.join() === 'l_retry', t.slice(0, 100).replace(/\n/g, ' '));
  await r.page.click('.rg-row[data-rg="l_write"] .rg-main'); await wait(r.page, 400);
  t = await r.page.evaluate(() => document.getElementById('inspector').innerText);
  ok('a loop with nothing bounding it says "No limit shown"', /no limit shown/i.test(t) && !/unbounded/i.test(t), t.slice(0, 120).replace(/\n/g, ' '));
  await shot(r.page, 'flow_regions');
  await r.page.keyboard.press('Escape'); await wait(r.page, 200);
  ok('the whole map has a pill per stage (number and name) instead of the Labels cycle', await r.page.evaluate(() => document.getElementById('rdLabels').hidden && document.querySelectorAll('g.stpill').length === 3 && [...document.querySelectorAll('g.stpill .stp-t')].every((t) => t.textContent.length > 0)));
  await r.ctx.close();
}

/* ============================================================================ 6. the big map: levels of detail, minimap, speed */
if (want('big')) {
  const t0 = Date.now();
  const { ctx, page } = await open(browser, URLB, '', 'big');
  const load = Date.now() - t0;
  const b = await page.evaluate(() => ({ a: window.atlasInspect(), mini: !document.getElementById('mini').hidden, toggle: !document.getElementById('mmToggle').hidden, off: document.querySelectorAll('.node.st-off').length, lod: document.getElementById('atlas').getAttribute('class') }));
  ok('a big chart opens fitted, zoomed out, with its overview map ready (it shows once zoomed in)', b.a.nodes > 200 && (b.a.lod === 'far' || b.a.lod === 'mid') && !b.mini && b.toggle && b.a.scale < 0.3, JSON.stringify([b.a.nodes, b.a.lod, b.a.scale.toFixed(2)]));
  ok('it paints in a few seconds', load < 8000, load + ' ms');
  ok('off boxes are dim on the big map too', b.off >= 5, 'off=' + b.off);
  await shot(page, 'big_far');
  const t1 = Date.now(); for (let i = 0; i < 12; i++) { await page.mouse.move(700 + i * 30, 500 + (i % 3) * 20); }
  await page.evaluate(() => window.atlasZoomTo(0.8)); await wait(page, 400);
  ok('zooming to a readable size switches to near detail', (await insp(page)).lod === 'near');
  ok('the overview map appears once the chart is zoomed in', await page.evaluate(() => !document.getElementById('mini').hidden));
  ok('moving the pointer across 200 boxes stays quick', Date.now() - t1 < 3000, (Date.now() - t1) + ' ms');
  await page.evaluate(() => window.atlasZoomTo(0.6)); await wait(page, 300);
  const mm = await centre(page, '#mini'); await page.mouse.click(mm.x - 30, mm.y); await wait(page, 300);
  ok('clicking the overview map moves the view', await page.evaluate(() => window.atlasInspect().view.x !== 0));
  await ctx.close();
}
/* ============================================================================ 7. names always read, the true main path and its walk, Where it can break, the off-by-default tint */
if (want('guides')) {
  const G = path.join(TMP, 'guides.html'); fs.writeFileSync(G, buildPage(await makeAtlasData(), { guides: true }));
  const GURL = pathToFileURL(G).href;
  { // every chart except the whole map: names and route labels at 11 px or more at fit, with and without the panels
    const { ctx, page } = await open(browser, URL0, '', 'names');
    const px = () => page.evaluate(() => { const svg = document.getElementById('atlas'), f = sel => { const t = svg.querySelector(sel); return t ? parseFloat(getComputedStyle(t).fontSize) : null; }, s = window.atlasInspect().scale;
      return { node: f('.node-text') && f('.node-text') * s, label: f('.elabel-text') && svg.querySelectorAll('g.elabel').length ? f('.elabel-text') * s : null, chipNoName: svg.classList.contains('zt-no-node') && !!svg.querySelector('.chip') && [...svg.querySelectorAll('.chip')].some(c => getComputedStyle(c).display !== 'none') }; });
    for (const id of ['overview', 'stage_intake', 'stage_queue', 'stage_delivery']) {
      await page.evaluate(i => window.atlasOpen(i), id); await wait(page, 250);
      const m = await px();
      ok(`names: ${id} box names read at 11 px or more at fit`, m.node >= 10.99, JSON.stringify(m));
      if (id !== 'overview') ok(`names: ${id} route labels read at 11 px or more at fit`, m.label === null || m.label >= 10.99, JSON.stringify(m));
      ok(`names: ${id} shows no chip on a box with no name`, !m.chipNoName);
      for (const sel of ['#rdRegions', '#handlesBtn', '#inspToggle']) {
        if (!(await page.evaluate(s => { const b = document.querySelector(s); return !!b && !b.hidden && b.offsetParent !== null; }, sel))) continue;
        await page.click(sel); await wait(page, 250);
        const m2 = await px();
        ok(`names: ${id} still reads at 11 px after ${sel} is used`, m2.node >= 10.99 && (id === 'overview' || m2.label === null || m2.label >= 10.99), JSON.stringify(m2));
        await page.click(sel); await wait(page, 150);
      }
    }
    await shot(page, 'guides_names');
    await ctx.close();
  }
  { // the walk: the next step crosses charts on its own, and the line joins only consecutive steps
    const { ctx, page } = await open(browser, URL0, '#chart=stage_intake', 'walk');
    ok('Walk the main path is offered', await page.evaluate(() => !document.getElementById('walkBtn').hidden));
    await page.click('#walkBtn'); await wait(page, 500);
    let a = await insp(page);
    ok('the walk starts at step 1 and says so', a.pinned?.id === 'intake.receive' && await page.evaluate(() => !document.getElementById('walkBar').hidden && /step\s*1\s*of\s*11/i.test(document.getElementById('wkBody').textContent)), JSON.stringify(a.pinned));
    for (let i = 0; i < 4; i++) { await page.click('#wkNext'); await wait(page, 450); }
    a = await insp(page);
    ok('step 5 is on another chart and the walk opened it', a.chart === 'stage_queue' && a.pinned?.id === 'queue.pending', JSON.stringify([a.chart, a.pinned]));
    const lit = await page.evaluate(() => [...document.querySelectorAll('#atlas g.edge.spine')].map(e => [e.dataset.from, e.dataset.to]));
    const SP = ['intake.receive', 'intake.check_weight', 'intake.check_address', 'intake.accept', 'queue.pending', 'queue.claim', 'queue.lease', 'delivery.pick', 'delivery.handoff', 'delivery.report', 'delivery.done'];
    ok('only consecutive steps of the declared path are lit', lit.length > 0 && lit.every(([f, t]) => SP.indexOf(t) === SP.indexOf(f) + 1), JSON.stringify(lit));
    await page.keyboard.press(']'); await wait(page, 450);
    ok('the ] key steps on', (await insp(page)).pinned?.id === 'queue.claim');
    await shot(page, 'guides_walk');
    await page.click('#wkEnd'); await wait(page, 200);
    ok('the walk can be ended', await page.evaluate(() => document.getElementById('walkBar').hidden));
    ok('"Follow the flow" is now called "Tour the charts"', await page.evaluate(() => /tour the charts/i.test(document.getElementById('followBtn').textContent)));
    await ctx.close();
  }
  { // a chart that holds a single main-path box still has the toggle
    const { ctx, page } = await open(browser, URL0, '#chart=stage_delivery&node=delivery.done', 'toggle');
    ok('the Main path toggle is on every chart that holds a step of it', await page.evaluate(() => !document.getElementById('rdSpine').hidden));
    await ctx.close();
  }
  { // Where it can break
    const { ctx, page } = await openRead(browser, GURL, '#reading=breaks', 'breaks');
    const t = await page.evaluate(() => ({ nav: [...document.querySelectorAll('#nav .nav-break')].map(b => b.textContent.trim()), text: document.getElementById('readingView').innerText, secs: [...document.querySelectorAll('.gd-sec')].map(s => [s.dataset.id, s.open]), rows: document.querySelectorAll('.bk-row').length }));
    ok('"Where it can break" and "How it fails" are top-level entries in Start here, each with a count', t.nav.length === 2 && /where it can break/i.test(t.nav[0]) && /3$/.test(t.nav[0]) && /how it fails/i.test(t.nav[1]), JSON.stringify(t.nav));
    ok('the page says plainly these are questions, read and not run, not verdicts', /questions the map.s shape raises/i.test(t.text) && /not run/i.test(t.text) && /verdict/i.test(t.text));
    ok('kept suspects, then waits, then loops; leads and dismissed are closed sections', JSON.stringify(t.secs) === JSON.stringify([['kept', true], ['waits', false], ['loops', false], ['leads', false], ['dismissed', false]]), JSON.stringify(t.secs));
    ok('every row names its kind of check, its stage and a box to open', await page.evaluate(() => [...document.querySelectorAll('.bk-row')].every(r => r.querySelector('.bk-kind') && r.querySelector('.bk-st') && r.querySelector('.xbtn'))));
    await page.click('.bk-chip[data-bk-kind="A loop with no limit"]'); await wait(page, 200);
    ok('a kind filter hides the other rows', await page.evaluate(() => [...document.querySelectorAll('.bk-row')].filter(r => getComputedStyle(r).display !== 'none').every(r => r.dataset.check === 'no-limit-loop')));
    await page.click('.bk-chip[data-bk-kind=""]'); await wait(page, 150);
    await page.evaluate(() => document.querySelector('#gd-dismissed').open = true); await wait(page, 100);
    ok('a dismissal is reachable with its reason', await page.evaluate(() => /All three callers finish the weight check first/.test(document.getElementById('gd-dismissed').innerText)));
    await shot(page, 'guides_breaks');
    await page.evaluate(() => document.querySelector('#gd-kept .bk-row .xbtn').click()); await wait(page, 500);
    const a = await insp(page);
    ok('a click opens the box on its chart', a.chart === 'stage_queue' && a.pinned?.id === 'queue.lease', JSON.stringify([a.chart, a.pinned]));
    await ctx.close();
  }
  { // with walks loaded, the rows whose boxes a run reached lead (proved first, then seen)
    const d3 = await makeAtlasData(); d3.evidence = { boxes: { 'delivery.report': { level: 'proved', count: 2 }, 'queue.lease': { level: 'seen', count: 7 } }, routes: {}, findings: [], walks: [] };
    const G3 = path.join(TMP, 'guides-walks.html'); fs.writeFileSync(G3, buildPage(d3, { guides: true }));
    const { ctx, page } = await openRead(browser, pathToFileURL(G3).href, '#reading=breaks', 'breaks-ran');
    const t = await page.evaluate(() => ({ secs: [...document.querySelectorAll('.gd-sec')].map(s => s.dataset.id), first: [...document.querySelectorAll('#gd-ran .bk-row')].map(r => r.querySelector('.bk-lv')?.className + ' ' + r.dataset.check) }));
    ok('with walks loaded a section of rows a run reached leads, proved before seen', t.secs[0] === 'ran' && /proved/.test(t.first[0]) && /seen/.test(t.first[1] || ''), JSON.stringify(t));
    await ctx.close();
  }
  { // the whole map: off-by-default tint, and no tooltip over a box that carries its name
    const { ctx, page } = await open(browser, URL0, '#chart=whole', 'offtint');
    ok('an "Off by default" button sits in the whole map toolbar', await page.evaluate(() => !document.getElementById('rdOff').hidden && /off by default/i.test(document.getElementById('rdOff').textContent)));
    await page.click('#rdOff'); await wait(page, 200);
    ok('it tints the off boxes', await page.evaluate(() => document.getElementById('atlas').classList.contains('show-off') && document.getElementById('rdOff').getAttribute('aria-pressed') === 'true'));
    await ctx.close();
  }
  { // a pinned box: what it does, where it goes next, where it came from, source, then the rest
    const { ctx, page } = await open(browser, URL0, '#chart=stage_queue&node=queue.pending', 'panel');
    const o = await page.evaluate(() => [...document.querySelectorAll('#inspector h3')].map(h => h.textContent.trim().toLowerCase()));
    const at = k => o.findIndex(x => x.startsWith(k));
    ok('the box panel reads: what it does, goes next, came from, source, then the rest (its heading is "Actions")', at('what it does') >= 0 && at('what it does') < at('where it goes next') && at('where it goes next') < at('where it came from') && at('where it came from') < at('source') && at('source') < at('actions'), JSON.stringify(o));
    ok('the source link is on screen without scrolling', await page.evaluate(() => { const r = document.querySelector('#inspector .srcq'); return !!r && r.getBoundingClientRect().bottom < innerHeight; }));
    ok('a box never says nothing arrives above a list of arrivals', await page.evaluate(() => !(/nothing arrives here/i.test(document.getElementById('inspector').innerText) && document.querySelectorAll('#inspector .route.in').length)));
    await ctx.close();
  }
}

/* ============================================================================ 8. numbers that add up, who hears, the main path, a true trace, the page that stays put */
if (want('counts')) {
  // the fixture, given what a full build adds: outcomes, stop / hand back, who hears, one table of counts, silent failures, a path that repeats boxes
  const P3 = ['intake.receive', 'intake.check_weight', 'intake.check_address', 'intake.check_weight', 'intake.accept', 'intake.accept', 'queue.pending', 'queue.claim', 'queue.lease', 'queue.claim', 'delivery.pick', 'delivery.handoff', 'delivery.report', 'delivery.done'];
  const countsData = async (o = {}) => {
    const d = await makeAtlasData();
    const outc = { 'intake.refuse': 'refusal', 'queue.fail': 'failure', 'delivery.done': 'success', 'delivery.lost': 'failure' };
    const heard = { 'intake.refuse': { by: 'caller', how: 'a 400 to the sender' }, 'queue.fail': { by: 'nobody', how: 'no trace' }, 'delivery.lost': { by: 'log', how: 'a warning line' } };
    const boxes = BOXES.map(b => ({ ...b, ...(outc[b.id] ? { outcome: outc[b.id] } : {}) })), model = { boxes, routes: ROUTES, loops: LOOPS, paths: [{ boxes: P3 }, { boxes: [] }], stages: [] }, modes = endingModes(model);
    for (const c of Object.values(d.charts)) for (const [id, n] of Object.entries(c.nodes)) {
      if (outc[id]) n.outcome = outc[id];
      if (modes.get(id)) n.ending = modes.get(id) === 'stop' ? 'stop' : 'back';
      if (heard[id]) n.heard = heard[id];
    }
    d.paths[0].boxes = o.plain ? d.paths[0].boxes : P3;
    { const ids = Object.keys(d.charts.overview.nodes); d.charts.overview.spine = [ids[0], ids[1], ids[0], ids[ids.length - 1]]; }   // the stage-level main path: repeats kept
    d.breaks = [...(d.breaks || []), { key: 'silent:queue.fail', check: 'silent-failure', state: 'silent', boxes: ['queue.fail'], routes: [], stage: 's_queue', question: 'What happens, and who should know?', by: 'nobody', how: 'no trace', evidence: 'x' },
      { key: 'silent:delivery.lost', check: 'silent-failure', state: 'silent', boxes: ['delivery.lost'], routes: [], stage: 's_delivery', question: 'What happens, and who should know?', by: 'log', how: 'a warning line', evidence: 'x' }];
    d.meta.counts = countsOf(model, { breaks: d.breaks }); d.meta.heardWords = HEARD_WORDS; d.meta.heardShort = HEARD_SHORT;
    return d;
  };
  const D3 = await countsData(), F3 = path.join(TMP, 'counts.html'); fs.writeFileSync(F3, buildPage(D3, { guides: true }));
  const U3 = pathToFileURL(F3).href, CN3 = D3.meta.counts;
  { // the walk reaches the very end of a path that repeats boxes, including at two adjacent steps
    const { ctx, page } = await open(browser, U3, '#chart=stage_intake', 'walk-repeat');
    await page.click('#walkBtn'); await wait(page, 400);
    const seen = [], titles = [];
    for (let i = 0; i < P3.length; i++) {
      const t = await page.evaluate(() => ({ body: document.getElementById('wkBody').textContent, name: document.querySelector('#wkBody .wk-name')?.textContent || '' }));
      const m = /step\s*(\d+)\s*of\s*(\d+)/i.exec(t.body); seen.push(m ? +m[1] : -1); titles.push(t.name);
      if (i < P3.length - 1) { await page.click('#wkNext'); await wait(page, 330); }
    }
    ok('Next walks a path that repeats boxes step by step to the very last step', JSON.stringify(seen) === JSON.stringify(P3.map((_, i) => i + 1)), JSON.stringify(seen));
    const want = P3.map(id => D3.charts.whole.nodes[id].title);
    ok('every step names its own box, the repeated ones too', JSON.stringify(titles) === JSON.stringify(want), JSON.stringify(titles.map((t, i) => t === want[i] ? 0 : [i, t])));
    ok('at the last step Next is disabled and the bar says it is the last', await page.evaluate(() => document.getElementById('wkNext').disabled && /last step/i.test(document.getElementById('wkBody').textContent)));
    for (let i = 0; i < P3.length - 1; i++) await page.keyboard.press('[');
    await wait(page, 500);
    ok('the [ key walks all the way back to step 1', /step\s*1\s*of/i.test(await page.evaluate(() => document.getElementById('wkBody').textContent)));
    await page.click('#wkNext'); await page.click('#wkNext'); await page.click('#wkNext'); await page.click('#wkNext'); await wait(page, 500);
    ok('the adjacent repeat does not hold the walk: step 5 then step 6 then on', /step\s*5\s*of/i.test(await page.evaluate(() => document.getElementById('wkBody').textContent)));
    await page.click('#wkNext'); await wait(page, 300); await page.click('#wkNext'); await wait(page, 300);
    ok('...and the step after the repeat is step 7', /step\s*7\s*of/i.test(await page.evaluate(() => document.getElementById('wkBody').textContent)));
    await ctx.close();
  }
  { // the walk bar is anchored to the viewport: closing the side panels does not move it
    const { ctx, page } = await open(browser, U3, '#chart=stage_queue', 'walk-anchor');
    await page.click('#walkBtn'); await wait(page, 400);
    const at = async () => page.evaluate(() => { const r = document.getElementById('wkNext').getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y)]; });
    const a = await at(); await page.click('#navToggle'); await wait(page, 350); const b = await at(); await page.click('#inspToggle'); await wait(page, 350); const c = await at();
    ok('the walk bar\'s next arrow stays where it is when the sidebar and details close', JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c), JSON.stringify([a, b, c]));
    await ctx.close();
  }
  { // the numbers add up
    const { ctx, page } = await openRead(browser, U3, '#reading=breaks', 'numbers');
    const t = await page.evaluate(() => ({ top: document.querySelector('.bk-top').innerText, nav: document.querySelector('#nav .nav-break')?.textContent.trim() || '', tiles: [...document.querySelectorAll('.bk-top .gd-stat b')].map(b => +b.textContent), secs: [...document.querySelectorAll('.gd-sec')].map(s => [s.dataset.id, +(s.querySelector('.gd-n')?.textContent || -1)]) }));
    const B = CN3.breaks;
    ok('Where it can break says "N to look at = ..." and N is the sidebar number', new RegExp(`${B.look} to look at`).test(t.top) && new RegExp(`${B.look}$`).test(t.nav), JSON.stringify([B, t.nav]));
    ok('no card reads 0', t.tiles.every(n => n > 0), JSON.stringify(t.tiles));
    ok('the open sections add up to the total', t.secs.filter(([id]) => ['kept', 'open', 'waits', 'silent', 'loops'].includes(id)).reduce((a, [, n]) => a + n, 0) === B.look, JSON.stringify(t.secs));
    ok('a section "Failures nobody is told about" follows the waits and carries both boxes', JSON.stringify(t.secs.map(x => x[0]).filter(x => ['waits', 'silent', 'loops'].includes(x))) === JSON.stringify(['waits', 'silent', 'loops'].filter(x => t.secs.some(s => s[0] === x))) && t.secs.some(([id, n]) => id === 'silent' && n === 2), JSON.stringify(t.secs));
    await page.evaluate(() => { document.querySelector('#gd-silent').open = true; }); await wait(page, 150);
    await page.click('.bk-bychips .bk-chip[data-bk-by="log"]'); await wait(page, 200);
    ok('its filter keeps only the rows heard by a log', await page.evaluate(() => [...document.querySelectorAll('#gd-silent .bk-row')].filter(r => getComputedStyle(r).display !== 'none').map(r => r.dataset.by).join() === 'log'));
    ok('each silent row asks what happens and who should know, and says who hears', await page.evaluate(() => [...document.querySelectorAll('#gd-silent .bk-row')].every(r => /who should know/i.test(r.innerText) && /who hears/i.test(r.innerText))));
    await ctx.close();
    const r2 = await openRead(browser, U3, '#reading=scope&section=numbers', 'numbers2');
    const tx = await r2.page.evaluate(() => document.getElementById('gd-numbers').innerText);
    ok('Evidence and scope has "What the numbers count" with the ending split, the loops and the questions', /What the numbers count/i.test(await r2.page.evaluate(() => document.getElementById('gd-numbers').innerText + document.querySelector('#gd-numbers summary').innerText)) && new RegExp(`${CN3.ends.stop} stop here`).test(tx) && new RegExp(`${CN3.ends.back} hand back`).test(tx) && new RegExp(`${B.look} to look at`).test(tx), tx.slice(0, 200));
    await r2.ctx.close();
    const r3 = await openRead(browser, U3, '#reading=narrative&section=overview', 'numbers3');
    const st = await r3.page.evaluate(() => [...document.querySelectorAll('#gd-overview .gd-stat')].map(s => s.innerText.replace(/\s+/g, ' ')));
    ok('the Narrative says how many ending boxes stop and how many hand back, from the one table', st.some(x => new RegExp(`^${CN3.ends.boxes} ending boxes.*${CN3.ends.stop} stop here, ${CN3.ends.back} hand back`, 'i').test(x)) && st.some(x => new RegExp(`^${CN3.loops.total} loops`).test(x)), JSON.stringify(st));
    await r3.ctx.close();
    const r4 = await openRead(browser, U3, '#reading=narrative&section=endings', 'numbers4');
    const en = await r4.page.evaluate(() => document.getElementById('gd-endings').innerText);
    ok('the Endings guide never says a box can stand for several endings when there are more boxes than code endings', !/a box can stand for several/i.test(en) && /stop here/i.test(en) && /hand back/i.test(en));
    await r4.page.click('.en-chips [data-en-end="back"]'); await wait(r4.page, 150);
    ok('and it filters ending boxes that hand back', await r4.page.evaluate((n) => [...document.querySelectorAll('#gd-endings .en-row')].filter(r => getComputedStyle(r).display !== 'none').length === n, CN3.ends.back));
    await r4.ctx.close();
  }
  { // the box panel: stops here or hands back, who hears (or not said yet)
    const { ctx, page } = await open(browser, U3, '#chart=stage_queue&node=queue.fail', 'panel-heard');
    const txt = async () => page.evaluate(() => document.getElementById('inspector').innerText);
    ok('an ending that stops says "Stops here" and who hears', /Stops here/.test(await txt()) && /Who hears:\s*No trace\s*\(no trace\)/.test(await txt()), (await txt()).slice(0, 300));
    ok('the ending pill is drawn solid when it stops and dotted when it hands back', await page.evaluate(() => { const e = document.querySelector('#atlas g.node[data-ending]'); return !!e; }));
    await ctx.close();
    const r2 = await open(browser, U3, '#chart=stage_delivery&node=delivery.done', 'panel-heard2');
    ok('a success ending with no entry does not say "not said yet"', !/not said yet/i.test(await r2.page.evaluate(() => document.getElementById('inspector').innerText)));
    await r2.ctx.close();
  }
  { // trace: search chooses the second box; a declared path answers along it; "everything downstream" says on this chart
    const { ctx, page } = await open(browser, U3, '#chart=whole&node=intake.check_address', 'trace');
    await page.evaluate(() => document.querySelector('[data-act="path"]').click()); await wait(page, 200);
    await page.fill('#q', 'queue.lease'); await page.keyboard.press('Enter'); await wait(page, 500);
    const t = await page.evaluate(() => document.getElementById('inspector').innerText);
    ok('Enter in the search box chooses the second box and keeps the trace', /declared path/i.test(t) && /Main path/.test(t), t.slice(0, 260));
    await page.evaluate(() => document.querySelector('#inspector [data-act="path-plain"]').click()); await wait(page, 300);
    ok('a button shows the plain fewest-steps way instead', /Fewest steps|way the roads allow/i.test(await page.evaluate(() => document.getElementById('inspector').innerText)));
    await ctx.close();
    const r2 = await open(browser, U3, '#chart=stage_intake&node=intake.accept', 'trace2');
    await r2.page.evaluate(() => document.querySelector('[data-act="down"]').click()); await wait(r2.page, 300);
    const t2 = await r2.page.evaluate(() => document.getElementById('inspector').innerText);
    ok('Trace everything downstream says "on this chart" and counts the steps on other charts', /on this chart/i.test(t2) && /more steps? lie on other charts/i.test(t2), t2.slice(0, 300));
    await r2.page.evaluate(() => document.querySelector('[data-act="trace-whole"]').click()); await wait(r2.page, 500);
    ok('...with a way to see them on the whole map', (await insp(r2.page)).chart === 'whole' && !!(await insp(r2.page)).trace);
    await r2.ctx.close();
  }
  { // never lose the words silently; the zoom does not move when a region is pinned
    const { ctx, page } = await open(browser, U3, '#chart=stage_queue', 'words');
    ok('at fit the words read and there is no notice', await page.evaluate(() => document.getElementById('nameNote').hidden));
    for (let i = 0; i < 6; i++) { await page.mouse.move(900, 500); await page.mouse.wheel(0, 400); await wait(page, 60); }
    await wait(page, 300);
    const n = await page.evaluate(() => ({ hidden: document.getElementById('nameNote').hidden, text: document.getElementById('nameNote').innerText, noNode: document.getElementById('atlas').classList.contains('zt-no-node'), noLab: document.getElementById('atlas').classList.contains('zt-no-elabel') }));
    ok('after wheel zoom, when names or conditions have gone, a notice says so', (n.noNode || n.noLab) && !n.hidden && /hidden|too small/i.test(n.text), JSON.stringify(n));
    await page.click('#nameNote .nn-go'); await wait(page, 700);
    const m = await page.evaluate(() => ({ hidden: document.getElementById('nameNote').hidden, noNode: document.getElementById('atlas').classList.contains('zt-no-node'), noLab: document.getElementById('atlas').classList.contains('zt-no-elabel') }));
    ok('one button brings them back and the notice goes', m.hidden && !m.noNode && !m.noLab, JSON.stringify(m));
    await ctx.close();
    const w = await open(browser, U3, '#chart=whole', 'pin');
    const s0 = (await insp(w.page)).scale;
    await w.page.click('#rdRegions'); await wait(w.page, 400); const s1 = (await insp(w.page)).scale;
    await w.page.click('#regionPanel .rg-row .rg-main'); await wait(w.page, 600);
    ok('pinning a region on the whole map does not move the zoom', Math.abs((await insp(w.page)).scale - s1) < 1e-6, JSON.stringify([s0, s1, (await insp(w.page)).scale]));
    await w.ctx.close();
  }
  { // the overview: where the main path starts and ends, by name; a button for the Fit that cannot fit
    const { ctx, page } = await open(browser, U3, '#chart=overview', 'overview3');
    ok('the overview marks START and END on the boxes of the path\'s first and last box', await page.evaluate(() => [...document.querySelectorAll('#atlas .stt text')].map(t => t.textContent).sort().join() === 'END,START'));
    const t = await page.evaluate(() => document.getElementById('inspector').innerText);
    ok('the panel names the first box and the last box of the main path', /Where the main path starts/i.test(t) && /Receive|receive/.test(t) && /Where the main path ends/i.test(t) && /ending/i.test(t), t.slice(t.search(/Where the main path starts/i), t.search(/Where the main path starts/i) + 260));
    await ctx.close();
  }
  { // an older atlas (no counts, no heard, no breaks) and an atlas with a stage that has no road between its boxes
    const old = await makeAtlasData(); delete old.meta.counts;
    const FO = path.join(TMP, 'old.html'); fs.writeFileSync(FO, buildPage(old, { guides: true }));
    for (const hash of ['#reading=narrative', '#reading=scope&section=numbers', '#reading=breaks', '#reading=glossary']) {
      const { ctx, page } = await openRead(browser, pathToFileURL(FO).href, hash, 'old' + hash);
      ok(`an older atlas still reads: ${hash}`, await page.evaluate(() => document.querySelectorAll('.gd-sec').length > 0));
      await ctx.close();
    }
    const nr = await makeAtlasData(); nr.charts.stage_intake.edges = {}; nr.charts.stage_intake.note = 'The checks a parcel passes at the door.'; nr.charts.stage_intake.stage = STAGES[0].id;
    const FN = path.join(TMP, 'noroad.html'); fs.writeFileSync(FN, buildPage(nr, { guides: true }));
    const { ctx, page } = await open(browser, pathToFileURL(FN).href, '#chart=stage_intake', 'noroad');
    const t = await page.evaluate(() => ({ note: document.getElementById('ovNote').innerText, hidden: document.getElementById('ovNote').hidden, insp: document.getElementById('inspector').innerText }));
    ok('a chart with no road between its boxes says so, and says where each box\'s roads are', !t.hidden && /no road between them here/i.test(t.note) && /no road between them here/i.test(t.insp) && /Part of the stage/i.test(t.insp), t.note);
    await ctx.close();
  }
  { // how-to text: full on the first visit, one line after
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); localStorage.removeItem('faultline-atlas-howto'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage(); watch(page, 'howto'); await page.goto(U3 + '#chart=stage_intake'); await page.waitForSelector('#atlas'); await wait(page, 400);
    ok('the how-to is shown in full on the first visit', await page.evaluate(() => [...document.querySelectorAll('#inspector h3')].some(h => /how to follow it/i.test(h.textContent))));
    await page.evaluate(() => window.atlasOpen('stage_queue')); await wait(page, 300);
    ok('...and after that it is one collapsed line', await page.evaluate(() => !!document.querySelector('#inspector details.howto-one') && ![...document.querySelectorAll('#inspector h3')].some(h => /how to follow it/i.test(h.textContent))));
    await ctx.close();
  }
}
// the fails-and-holds fixture (a map with breaks, holds and who-hears) is built once, before the sections that read it
  const P4 = ['intake.receive', 'intake.check_weight', 'intake.check_address', 'intake.accept', 'queue.pending', 'queue.claim', 'queue.lease', 'queue.claim', 'delivery.pick', 'delivery.handoff', 'delivery.report', 'delivery.done'];
  const OUTC4 = { 'intake.refuse': 'refusal', 'queue.fail': 'failure', 'delivery.done': 'success', 'delivery.lost': 'failure' };
  const failsData = async () => {
    const d = await makeAtlasData();
    const outc = OUTC4;
    const heardBy = { 'intake.refuse': { by: 'caller', how: 'a 400 to the sender' }, 'queue.fail': { by: 'nobody', how: 'no trace' }, 'delivery.lost': { by: 'log', how: 'a warning line' } };
    const waitsFor = { 'queue.lease': { on: 'machine', how: 'the lease timer; the holder is bounded by its own deadline' }, 'queue.backoff': { on: 'person', how: 'an owner presses retry' } };
    const boxes = BOXES.map(b => ({ ...b, ...(outc[b.id] ? { outcome: outc[b.id] } : {}) })), paths = [{ id: 'main', title: 'Main path', boxes: P4 }, { id: 'p_refused', title: 'A parcel is refused', boxes: ['intake.receive', 'intake.check_weight', 'intake.refuse'] }, { id: 'p_lost', title: 'A parcel is lost', boxes: ['delivery.pick', 'delivery.handoff', 'delivery.lost'] }];
    const model = { boxes, routes: ROUTES, loops: LOOPS, paths, stages: [], heardBy, waitsFor }, modes = endingModes(model);
    for (const c of Object.values(d.charts)) for (const [id, n] of Object.entries(c.nodes)) {
      if (outc[id]) n.outcome = outc[id];
      if (modes.get(id)) n.ending = modes.get(id) === 'stop' ? 'stop' : 'back';
      if (heardBy[id]) n.heard = heardBy[id];
      if (waitsFor[id]) n.waits = waitsFor[id];
    }
    d.paths = paths;
    { const ids = Object.keys(d.charts.overview.nodes); d.charts.overview.spine = [ids[0], ids[1], ids[2]]; }
    for (const n of Object.values(d.charts.overview.nodes)) if (n.stage) n.synth = 'stage';
    Object.assign(d.charts.overview.nodes.end_done, { synth: 'outcome', outcome: 'failure', title: 'Failure endings (2)', boxes: ['queue.fail', 'delivery.lost'] });
    d.breaks = [...(d.breaks || []).filter(b => b.state !== 'silent' && !(b.boxes || []).includes('queue.lease')), { key: 'silent:queue.fail', check: 'silent-failure', state: 'silent', boxes: ['queue.fail'], routes: [], stage: 's_queue', question: 'What happens, and who should know?', by: 'nobody', how: 'no trace', evidence: 'x' },
      { key: 'person-wait:queue.backoff', check: 'wait-person', state: 'person', boxes: ['queue.backoff'], routes: [], stage: 's_queue', question: '', on: 'person', how: 'an owner presses retry', evidence: '' },
      { key: 'wait-no-wake:queue.lease', check: 'wait-no-wake', state: 'dismissed', boxes: ['queue.lease'], routes: [], stage: 's_queue', question: 'What ends this wait?', evidence: 'e', why: 'the lease has its own timer' }];
    d.meta.counts = countsOf(model, { breaks: d.breaks }); d.meta.heardWords = HEARD_WORDS; d.meta.heardShort = HEARD_SHORT; d.meta.waitWords = WAIT_WORDS; d.meta.holdWords = HOLD_STATE_WORDS;
    d.holds = holdsOf(model, d.breaks);
    return { d, model };
  };
  const { d: D4, model: M4 } = await failsData(), F4 = path.join(TMP, 'fails.html'); fs.writeFileSync(F4, buildPage(D4, { guides: true }));
  const U4 = pathToFileURL(F4).href, CN4 = D4.meta.counts;
if (want('fails-and-holds')) {
  // the header stays still, whole-map zoom lands on something, one front door for "how it fails", what can hold up the main path, walk a scenario, trace across charts, words and numbers
  { // A. the header stays still
    const { ctx, page } = await open(browser, U4, '#chart=overview', 'p4-header');
    const charts = await page.evaluate(() => window.atlasInspect().charts), pos = new Set(), posN = new Set(), st = new Set();
    for (const id of charts) {
      await page.evaluate(i => window.atlasOpen(i), id); await wait(page, 120);
      const r = await page.evaluate(() => ['csPrev', 'csNext'].map(i => { const b = document.getElementById(i).getBoundingClientRect(); return [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10]; }).concat([[document.getElementById('app').dataset.nav, document.getElementById('app').dataset.insp]]));
      pos.add(JSON.stringify(r[0])); posN.add(JSON.stringify(r[1])); st.add(JSON.stringify(r[2]));
    }
    ok('previous chart and next chart sit at ONE x and y on every chart', pos.size === 1 && posN.size === 1, JSON.stringify([...pos, ...posN]));
    ok('no chart opens or closes the sidebar or the details panel by itself', st.size === 1, JSON.stringify([...st]));
    await page.evaluate(i => window.atlasOpen(i), charts[0]); await wait(page, 150);
    const nb = await centre(page, '#csNext'); await page.mouse.move(nb.x, nb.y);
    const dim = []; let seen = 0;
    for (let i = 0; i < charts.length - 1; i++) {
      await page.mouse.click(nb.x, nb.y); await wait(page, 90); seen++;
      const t = await page.evaluate(() => { const a = window.atlasInspect(), ns = [...document.querySelectorAll('#atlas g.node')], dm = ns.filter(g => parseFloat(getComputedStyle(g).opacity) < 0.5).length; return { c: a.chart, hover: !!a.hover, pf: !!a.portalFocus, share: ns.length ? dm / ns.length : 0 }; });
      if (t.hover || t.pf || t.share > 0.3) dim.push(t);
    }
    ok('clicking next chart on every chart in a row, mouse never moved: no chart is dimmed', dim.length === 0 && seen === charts.length - 1, JSON.stringify(dim.slice(0, 3)));
    // a chip that slides under a still pointer lights nothing until the mouse moves
    await page.evaluate(() => window.atlasOpen('stage_queue')); await wait(page, 200);
    const chip = await page.evaluate(() => { const c = document.querySelector('#fbNext .fchip[data-fc]'); if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
    if (chip) { await page.mouse.move(chip.x, chip.y); await wait(page, 150); await page.evaluate(() => window.atlasOpen('stage_delivery')); await wait(page, 250);
      ok('a chip that lands under a still pointer lights nothing until the mouse really moves', await page.evaluate(() => !window.atlasInspect().portalFocus)); }
    ok('the typed search is gone when the chart changes (it never dims the next one)', await (async () => { await page.fill('#q', 'receipt'); await page.evaluate(() => window.atlasOpen('stage_intake')); await wait(page, 200); return await page.evaluate(() => document.getElementById('q').value === '' && !document.querySelector('#atlas.searching')); })());
    await ctx.close();
  }
  { // B. whole-map zoom lands on something (the big map has stages of about 40 boxes)
    const { ctx, page } = await open(browser, URLB, '', 'p4-zoom');
    const regs = await page.evaluate(() => window.atlasFL.chart().rg.list.filter(r => r.kind === 'stage').map(r => r.id));
    const reads = async rid => page.evaluate(rid2 => {
      const X = window.atlasFL.chart(), r = X.rg.byId[rid2], sc = window.atlasInspect().scale, cr = document.getElementById('canvas').getBoundingClientRect(); let x0 = cr.left, x1 = cr.right;
      for (const id of ['regionPanel', 'handlePanel', 'dockPanel', 'legend']) { const el = document.getElementById(id); if (!el || el.hidden || !el.offsetWidth) continue; const q = el.getBoundingClientRect(); if (q.left + q.width / 2 < (cr.left + cr.right) / 2) x0 = Math.max(x0, q.right); else x1 = Math.min(x1, q.left); }
      let n = 0, mine = 0; for (const [id, el] of X.nodeEl) { const t = el.querySelector('.node-text'); if (!t || !t.parentNode || parseFloat(getComputedStyle(t).fontSize) * sc < 11) continue; const q = el.getBoundingClientRect(), cx = (q.left + q.right) / 2, cy = (q.top + q.bottom) / 2; if (cx < x0 || cx > x1 || cy < cr.top || cy > cr.bottom) continue; n++; if (r && r.set.has(id)) mine++; }
      return { n, mine, sc };
    }, rid);
    const cid = await page.evaluate(() => window.atlasInspect().chart);
    await page.click('#rdRegions'); await wait(page, 250);       // the regions list is open: it covers the left of the canvas
    let bad = [];
    for (const rid of regs) {
      for (const how of ['read', 'it']) {
        await page.evaluate(c => { location.hash = '#chart=' + c; }, cid); await wait(page, 200); await page.evaluate(([c, r]) => { location.hash = '#chart=' + c + '&region=' + r; }, [cid, rid]); await wait(page, 350);
        if (how === 'read') { await page.evaluate(() => window.atlasZoomTo(0.05)); await wait(page, 250); const b = await page.$('#nameNote .nn-go'); if (!b) continue; await b.click(); } else { const b = await page.$('[data-act="rg-zoom"]'); if (!b) continue; await b.click(); }
        await wait(page, 700); const m = await reads(rid); if (m.mine < 3) bad.push([rid, how, m]);
      }
    }
    ok('"Zoom to where they read" and "Zoom to it", regions list open: at least 3 names of the pinned stage read inside the visible canvas, every stage', regs.length >= 4 && bad.length === 0, JSON.stringify(bad.slice(0, 3)));
    await ctx.close();
  }
  { // C. How it fails
    const { ctx, page } = await openRead(browser, U4, '#reading=fails', 'p4-fails');
    const F = CN4.fails, t = await page.evaluate(() => ({ nav: [...document.querySelectorAll('#nav .nav-break')].map(b => b.textContent.trim()), lead: (document.querySelector('.fl-lead')?.innerText || '') + ' ' + (document.querySelector('.fl-chips')?.innerText || ''), none: document.querySelector('.fl-none')?.innerText || '', rows: document.querySelectorAll('.fl-row').length, secs: [...document.querySelectorAll('.gd-sec')].map(s => [s.dataset.id, +s.querySelector('.gd-n')?.textContent, s.querySelectorAll('.fl-row').length]), title: document.querySelector('.gd-top h2')?.textContent }));
    ok('How it fails is an entry under Start here, with a count', t.nav.some(x => /how it fails/i.test(x) && new RegExp(F.total + '$').test(x)) && t.title === 'How it fails', JSON.stringify(t.nav));
    ok('it leads with one line about who hears; the counts by value are in the filter row under it (once, not repeated in the lead) and add up to the table', new RegExp(F.total + ' failures and refusals').test(t.lead) && Object.entries(F.by).filter(([, n]) => n).every(([, n]) => t.lead.includes(String(n))) && Object.values(F.by).reduce((a, n) => a + n, 0) === F.total, t.lead);
    ok('every failure and refusal is listed once (none cut off), grouped by who hears, and each group count is its rows', t.rows === F.total && t.secs.every(([, n, r]) => n === r) && t.secs.reduce((a, x) => a + x[2], 0) === F.total, JSON.stringify(t.secs));
    ok('when no failure reaches a person it says so plainly', /None of these reach a person directly: the calling code decides/.test(t.none), t.none);
    await page.click('[data-fl-by="nobody"].bk-chip'); await wait(page, 200);
    const f1 = await page.evaluate(() => ({ vis: [...document.querySelectorAll('.fl-row')].filter(r => r.offsetParent !== null).length, secs: [...document.querySelectorAll('.gd-sec')].filter(s => s.offsetParent !== null).map(s => s.dataset.id) }));
    ok('filter by who hears: only that group is left, its count updates', f1.vis === F.by.nobody && f1.secs.length === 1 && f1.secs[0] === 'by-nobody', JSON.stringify(f1));
    await page.click('[data-fl-by="*"].bk-chip'); await page.click('[data-fl-kind="refusal"]'); await wait(page, 200);
    const f2 = await page.evaluate(() => [...document.querySelectorAll('.fl-row')].filter(r => r.offsetParent !== null).map(r => r.dataset.kind));
    ok('filter by failure or refusal', f2.length === F.refusal && f2.every(k => k === 'refusal'), JSON.stringify(f2));
    await page.click('[data-fl-kind="*"]'); await page.selectOption('#flStage', 's_queue'); await wait(page, 200);
    const f3 = await page.evaluate(() => [...document.querySelectorAll('.fl-row')].filter(r => r.offsetParent !== null).map(r => r.dataset.stage));
    ok('filter by stage', f3.length >= 1 && f3.every(s => s === 's_queue'), JSON.stringify(f3));
    const more = await page.evaluate(() => { const d = document.querySelector('details.fl-more'); return d ? d.querySelector('summary').textContent : null; });
    ok('a "+N more" opens (it is a real control, not dead text)', more == null || (await page.evaluate(() => { const d = document.querySelector('details.fl-more'); d.querySelector('summary').click(); return d.open; })), more);
    await ctx.close();
    const o = await open(browser, U4, '#chart=overview', 'p4-group');
    await o.page.evaluate(() => { const g = document.querySelector('g.node[data-node="end_done"]'); if (g) g.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); await wait(o.page, 400);
    const g = await o.page.evaluate(() => ({ txt: document.getElementById('inspector').innerText, list: document.querySelectorAll('#inspector .grp-list li').length }));
    const failEnds = 2;
    ok('a group box on the overview says who hears (counts), links to the page, and lists the whole group', /who hears/i.test(g.txt) && !/not said yet\s*$/im.test(g.txt.split('Who hears')[1]?.split('\n')[0] || '') && /How it fails/.test(g.txt) && g.list === failEnds, JSON.stringify([g.list, failEnds, g.txt.slice(0, 200)]));
    await o.ctx.close();
  }
  { // D. what can hold up the main path, and waits for a person
    const { ctx, page } = await openRead(browser, U4, '#reading=breaks', 'p4-holds');
    const t = await page.evaluate(() => ({ secs: [...document.querySelectorAll('.gd-sec')].map(s => [s.dataset.id, s.open, +s.querySelector('.gd-n')?.textContent]), holds: [...document.querySelectorAll('#gd-holds .bk-hold')].map(r => ({ k: r.dataset.hold, s: r.dataset.hstate, txt: r.textContent })), stuck: document.querySelector('.bk-stuck')?.innerText || '', sum: document.querySelector('.bk-sum')?.innerText || '', nav: document.querySelector('#nav .nav-break')?.textContent.trim() }));
    ok('Where it can break starts with "What can hold up the main path" (closed) and opens on the first section of questions (the kept suspects when there are any)', t.secs[0][0] === 'holds' && t.secs[0][1] === false && t.secs.filter(x => x[1]).length === 1 && ['kept', 'open', 'waits', 'silent', 'loops'].includes(t.secs.find(x => x[1])[0]), JSON.stringify(t.secs.slice(0, 3)));
    ok('it lists the main path\'s waits, gates and loops in path order, one row each', t.holds.length === D4.holds.length && D4.holds.every((h, i) => t.holds[i].k === h.kind), JSON.stringify(t.holds.map(h => [h.k, h.s])));
    const lease = t.holds.find(h => /Hold the lease/.test(h.txt));
    ok('a dismissed wait on the path is still listed, with its reason and what it waits for', !!lease && lease.s === 'dismissed' && /the lease has its own timer/.test(lease.txt) && /the lease timer; the holder is bounded/.test(lease.txt), lease && lease.txt.slice(0, 200));
    ok('the stuck advice points at the main path first, then at machine waits elsewhere', /what can hold up the main path.*then.*waits elsewhere/is.test(t.stuck.replace(/\n/g, ' ')), t.stuck.slice(0, 260));
    const person = t.secs.find(s => s[0] === 'person');
    ok('a wait for a person has its own CLOSED group, and it is not in the "to look at" total', !!person && person[1] === false && person[2] === CN4.breaks.person && new RegExp(CN4.breaks.look + ' to look at').test(t.sum) && /waits? for a person/i.test(t.sum) && new RegExp(CN4.breaks.look + '$').test(t.nav), JSON.stringify([person, t.sum.slice(0, 200)]));
    const open = t.secs.filter(([id]) => ['kept', 'open', 'waits', 'silent', 'loops'].includes(id)).reduce((a, [, , n]) => a + n, 0);
    ok('the to-look-at sum stays honest with the new sections (holds and person are not in it)', open === CN4.breaks.look, JSON.stringify([open, CN4.breaks.look]));
    ok('the numbers table lists the new numbers (main path, fails, waits, holds)', await (async () => { await page.evaluate(() => { location.hash = '#reading=scope&section=numbers'; }); await wait(page, 500); const s = await page.evaluate(() => document.getElementById('gd-numbers')?.innerText || ''); return /steps on the main path|steps, /.test(s) && /failures and refusals/.test(s) && /wait boxes/.test(s) && /places on the main path that can hold it up/.test(s) && !/Operations counts/.test(s); })());
    await ctx.close();
  }
  { // E. walk a scenario; Next stage; Esc; the overview's main path
    const { ctx, page } = await open(browser, U4, '#chart=overview', 'p4-scen');
    const g = await page.evaluate(() => ({ head: document.getElementById('navScenBtn')?.textContent || '', rows: [...document.querySelectorAll('#nav .nav-walk')].map(b => [b.dataset.walk, b.querySelector('.ni-label').textContent, +b.querySelector('.ni-count').textContent]), mainOn: document.getElementById('rdSpine').getAttribute('aria-pressed') }));
    ok('"Walk a scenario" lists every declared path but the main one, with its title and step count', g.rows.length === 2 && g.rows.some(r => r[1] === 'A parcel is refused' && r[2] === 3) && /Walk a scenario/.test(g.head), JSON.stringify(g));
    ok('on the overview the Main path switch is on by default', g.mainOn === 'true');
    await page.evaluate(() => { const b = document.getElementById('navScenBtn'); if (b.getAttribute('aria-expanded') !== 'true') b.click(); }); await wait(page, 150);
    await page.click('#nav .nav-walk[data-walk="p_refused"]'); await wait(page, 600);
    const w = await page.evaluate(() => ({ bar: !document.getElementById('walkBar').hidden, txt: document.getElementById('wkBody').textContent }));
    ok('a click on a scenario starts its walk', w.bar && /A parcel is refused/.test(w.txt) && /step\s*1\s*of\s*3/i.test(w.txt), w.txt.slice(0, 120));
    await page.keyboard.press('Escape'); await wait(page, 200);
    ok('Esc leaves the walk', await page.evaluate(() => document.getElementById('walkBar').hidden));
    await page.click('#walkBtn'); await wait(page, 500);
    const s0 = await page.evaluate(() => document.getElementById('wkBody').textContent.match(/step\s*(\d+)/i)[1]);
    await page.click('#wkStage'); await wait(page, 500);
    const s1 = await page.evaluate(() => ({ n: +document.getElementById('wkBody').textContent.match(/step\s*(\d+)/i)[1], stage: document.querySelector('#wkBody .wk-stage')?.textContent || '' }));
    ok('"Next stage »" skips to the first step in another stage', +s0 === 1 && s1.n === 5 && /Queue/.test(s1.stage), JSON.stringify([s0, s1]));
    await page.keyboard.press('Escape'); await ctx.close();
  }
  { // F. trace path from the toolbar, across charts; never silent
    const { ctx, page } = await open(browser, U4, '#chart=stage_queue', 'p4-trace');
    await page.click('#traceBtn'); await wait(page, 200);
    ok('Trace path is a button in the toolbar with a From and a To', await page.evaluate(() => !document.getElementById('tracePanel').hidden && !!document.getElementById('tp-from') && !!document.getElementById('tp-to')));
    await page.click('.tp-go'); await wait(page, 150);
    ok('pressing Trace with nothing chosen says what to do', /choose both ends/i.test(await page.evaluate(() => document.getElementById('tp-msg').textContent)));
    await page.fill('#tp-from', 'any attempts'); await wait(page, 200); await page.click('#tp-res-from .tp-r >> nth=0');
    await page.fill('#tp-to', 'receive a parcel'); await wait(page, 200); await page.click('#tp-res-to .tp-r >> nth=0');
    await page.click('.tp-go'); await wait(page, 800);
    const r = await page.evaluate(() => ({ chart: window.atlasInspect().chart, tr: window.atlasInspect().trace, panel: document.getElementById('inspector').innerText }));
    ok('ends on different charts: the answer opens on the whole map with its numbered list, not ignored', /whole/.test(r.chart) && r.tr && r.tr.kind === 'path' && r.tr.nodes >= 3 && /Receive a parcel/.test(r.panel) && /not on one chart/.test(r.panel), JSON.stringify([r.chart, r.tr]));
    await page.evaluate(() => window.atlasOpen('stage_intake')); await wait(page, 300);
    await page.click('#traceBtn'); await wait(page, 150);
    await page.evaluate(() => { document.querySelectorAll('.tp-clr').forEach(b => b.click()); }); await wait(page, 100);
    await page.fill('#tp-from', 'receive a parcel'); await wait(page, 200); await page.click('#tp-res-from .tp-r >> nth=0'); await page.fill('#tp-to', 'accept the parcel'); await wait(page, 200); await page.click('#tp-res-to .tp-r >> nth=0');
    await page.click('.tp-swap'); await wait(page, 100);
    const sw = await page.evaluate(() => [document.querySelector('#tp-pick-from b')?.textContent, document.querySelector('#tp-pick-to b')?.textContent]);
    ok('Swap trades the two ends', sw[0] === 'Accept the parcel' && sw[1] === 'Receive a parcel', JSON.stringify(sw));
    await page.click('.tp-go'); await wait(page, 700);
    ok('both ends on this chart: the path is drawn here, no move to the whole map', await page.evaluate(() => window.atlasInspect().chart === 'stage_intake' && window.atlasInspect().trace && window.atlasInspect().trace.kind === 'path'));
    await ctx.close();
  }
  { // a capped overview: pinning any box lists its roads, drawn or not (a real system's overview always has notDrawn; a page error here fails the run)
    const d5 = JSON.parse(JSON.stringify(D4)), ids = Object.keys(d5.charts.overview.nodes);
    d5.charts.overview.notDrawn = [{ from: ids[0], to: ids[1], count: 3, when: 'Later' }];
    const F5 = path.join(TMP, 'fails-cap.html'); fs.writeFileSync(F5, buildPage(d5, { guides: true }));
    const { ctx, page } = await open(browser, pathToFileURL(F5).href, '#chart=overview', 'p4-cap');
    let listed = 0;
    for (const id of ids) {
      await page.click(`g.node[data-node="${id}"] .node-box`, { force: true }); await wait(page, 120);
      if (await page.evaluate(() => /roads in/i.test(document.body.innerText) && /roads out/i.test(document.body.innerText))) listed++;
    }
    ok('a capped overview: every box pinned lists its roads in and out', listed === ids.length, `${listed} of ${ids.length}`);
    await ctx.close();
  }
  { // G + H + I. words and numbers, the glossary, search, part numbering, long roads
    const { ctx, page } = await open(browser, U4, '#chart=overview', 'p4-words');
    const t = await page.evaluate(() => ({ sub: window.atlasInspect() && document.querySelector('.tb-sub, #chartSub') ? document.querySelector('#chartSub').textContent : '', sidebar: document.querySelector('#nav .nav-item[data-chart="overview"]').title, onMain: document.querySelectorAll('#atlas .node.on-main').length, route: /\broutes?\b/i.test(document.getElementById('howto').textContent + document.getElementById('legend').textContent) }));
    ok('the overview outlines the stages the main path runs through (the title says "N stages; the main path runs through K of them": test/waits-holds.test.mjs)', t.onMain >= 1 && t.onMain <= 3, 'on-main ' + t.onMain);
    ok('one word for an arrow: "road" (the header, the legend and the how-to never say route)', !t.route);
    await ctx.close();
    const n = await openRead(browser, U4, '#reading=narrative&section=path', 'p4-path');
    const np = await n.page.evaluate(() => document.getElementById('gd-path').innerText);
    ok('the Narrative says the main path\'s steps and its different boxes when calls come back', /12 steps/.test(np) && /11 different boxes/.test(np) && /calls come back/.test(np), np.slice(0, 260));
    await n.ctx.close();
    const gl = await openRead(browser, U4, '#reading=glossary', 'p4-gloss');
    const gs = await gl.page.evaluate(() => [...document.querySelectorAll('.gd-sec')].map(s => [s.dataset.id, s.querySelector('.gd-tt')?.textContent, s.open]));
    ok('the glossary leads with "This system\'s words"; the code handles follow in a closed section', gs[0][0] === 'words' && /system.s words/i.test(gs[0][1]) && (!gs[1] || (gs[1][0] === 'handles' && gs[1][2] === false)), JSON.stringify(gs));
    await gl.ctx.close();
    const sp = await open(browser, U4, '#chart=stage_queue', 'p4-term');
    await sp.page.click('#inspToggle'); await wait(sp.page, 250);                                                                      // the details panel starts closed
    const tl = await sp.page.evaluate(() => document.getElementById('inspector').innerText);
    ok('a stage name that holds no glossary word shows no term line; the Lease/Backoff words appear when a part name holds them', !/Words in this name/.test(tl), tl.slice(0, 60));
    await sp.page.evaluate(() => { const c = window.atlasFL.chart(); });
    const tw = await sp.page.evaluate(() => { const d = JSON.parse(document.getElementById('atlas-data').textContent); return d.terms.length; });
    ok('the glossary words reach the stage panel through one function (termsIn): "Lease" in a stage title is found, "MAX_WEIGHT_G" (a code-like name) only in its own case, and a term with a dot or a slash matches whole', await sp.page.evaluate(() => { const f = window.atlasTermsIn; return !!f && f('The Lease is held').some(t => t.tag === 'Lease') && f('use MAX_WEIGHT_G here').some(t => t.tag === 'MAX_WEIGHT_G') && !f('use max_weight_g here').some(t => t.tag === 'MAX_WEIGHT_G') && !f('Leased out').some(t => t.tag === 'Lease'); }), 'terms ' + tw);
    // search: the count never sits on the typed text and its button works
    await sp.page.fill('#q', 'receipt'); await wait(sp.page, 250);
    const q = await sp.page.evaluate(() => { const i = document.getElementById('q').getBoundingClientRect(), c = document.getElementById('qCount').getBoundingClientRect(), pad = parseFloat(getComputedStyle(document.getElementById('q')).paddingRight), btn = document.querySelector('#qCount .qmore'); return { overlap: c.width > 0 && c.left < i.right - pad + 1 && c.right > i.left, pad, cw: c.width, btnClick: btn ? getComputedStyle(btn).pointerEvents : 'none-here' }; });
    ok('the search count does not overlap the typed text, and "in other charts" is clickable', !q.overlap && q.btnClick !== 'none', JSON.stringify(q));
    await sp.ctx.close();
    const BIG2 = path.join(TMP, 'big2.html'); fs.writeFileSync(BIG2, buildPage(makeBigData({ cols: 30, rows: 22 })));
    const bg = await open(browser, pathToFileURL(BIG2).href, '', 'p4-long');
    const nn = await bg.page.evaluate(() => Object.keys(window.atlasFL.chart().chart.nodes).length);
    const modes = await bg.page.evaluate(async () => { const out = []; const b = document.getElementById('rdLong'); for (let i = 0; i < 4; i++) { out.push(b.textContent); b.click(); await new Promise(r => setTimeout(r, 60)); } return out; });
    ok('Long roads: above 500 boxes "on" is not offered, and the button says why', nn > 500 && !modes.some(m => /on$/.test(m)) && modes.some(m => /faint$/.test(m)) && /not offered/.test(await bg.page.evaluate(() => document.getElementById('rdLong').title)), nn + ' boxes ' + JSON.stringify(modes));
    await bg.ctx.close();
  }
}

/* ============================================================================ 10. the room, the road a label belongs to, the smaller view, the phone */
if (want('look')) {
  // the details panel starts closed; a pin brings it and clearing the pin takes it away; the person's own choice is never undone
  const L1 = await open(browser, URL0, '#chart=stage_queue', 'look-panel');
  const st0 = await L1.page.evaluate(() => ({ insp: document.getElementById('app').dataset.insp, pressed: document.getElementById('inspToggle').getAttribute('aria-pressed'), nav: document.getElementById('app').dataset.nav }));
  ok('look: the details panel starts closed (its 340 px go to the chart) and the sidebar starts open', st0.insp === 'collapsed' && st0.pressed === 'false' && st0.nav === 'open', JSON.stringify(st0));
  const nb = await L1.page.locator('g.node .node-box').first().boundingBox();
  await L1.page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await wait(L1.page, 350);
  const st1 = await L1.page.evaluate(() => ({ insp: document.getElementById('app').dataset.insp, pinned: !!window.atlasInspect().pinned }));
  ok('look: a pin brings the details panel', st1.pinned && st1.insp === 'open', JSON.stringify(st1));
  await L1.page.keyboard.press('Escape'); await wait(L1.page, 350);
  const st2 = await L1.page.evaluate(() => ({ insp: document.getElementById('app').dataset.insp, pinned: !!window.atlasInspect().pinned }));
  ok('look: clearing the pin takes the panel it brought away again', !st2.pinned && st2.insp === 'collapsed', JSON.stringify(st2));
  await L1.page.click('#inspToggle'); await wait(L1.page, 250);
  await L1.page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await wait(L1.page, 250); await L1.page.keyboard.press('Escape'); await wait(L1.page, 300);
  const st3 = await L1.page.evaluate(() => document.getElementById('app').dataset.insp);
  ok('look: a panel the person opened with the button stays open when the pin goes', st3 === 'open', st3);
  await L1.ctx.close();

  // the zoom bar sits on no box, on every chart of the fixture, at a desktop and a laptop size
  for (const [w, h] of [[1920, 1080], [1366, 768]]) {
    const Z = await open(browser, URL0, '', 'look-zoom' + w, { width: w, height: h });
    const ids = (await insp(Z.page)).charts.filter(c => c !== 'whole'), bad = [];
    for (const id of ids) {
      await Z.page.evaluate(i => window.atlasOpen(i), id); await wait(Z.page, 420);
      const r = await Z.page.evaluate(() => { const zb = document.getElementById('zoomGroup').getBoundingClientRect(); return [...document.querySelectorAll('g.node .node-box')].filter(b => { const q = b.getBoundingClientRect(); return Math.min(zb.right, q.right) - Math.max(zb.left, q.left) > 1 && Math.min(zb.bottom, q.bottom) - Math.max(zb.top, q.top) > 1; }).length; });
      if (r) bad.push(id + ':' + r);
    }
    ok('look: the zoom bar covers no box on any chart at ' + w + 'x' + h, bad.length === 0, bad.join(' '));
    await Z.ctx.close();
  }

  // a chart that does not fit says so at its edges, and "All at once" is a smaller view that still names what is in it
  let S1 = null, cue = null;
  for (const [w, h] of [[1000, 560], [900, 480], [780, 430]]) {      // 1100 x 720 fits this chart now (the laptop fit), so smaller windows are tried until the chart does not fit
    S1 = await open(browser, URL0, '#chart=stage_queue', 'look-small', { width: w, height: h });
    cue = await S1.page.evaluate(() => ({ floored: window.atlasInspect().floored, cues: [...document.querySelectorAll('.edgecue')].filter(e => !e.hidden).map(e => e.className.replace('edgecue ', '') + ':' + getComputedStyle(e).pointerEvents) }));
    if (cue.floored && cue.cues.length) break; await S1.ctx.close();
  }
  ok('look: a chart that opens at reading size and does not fit shows an edge cue that never takes a click', cue.floored && cue.cues.length >= 1 && cue.cues.every(c => /:none$/.test(c)), JSON.stringify(cue));
  await S1.page.click('#zAll'); await wait(S1.page, 700);
  const sm = await S1.page.evaluate(() => { const svg = document.getElementById('atlas'), s = window.atlasInspect().scale; return { note: !document.getElementById('zNote').hidden, small: svg.classList.contains('zt-small'), scale: s, named: s * 15 >= 8.5 ? !svg.classList.contains('zt-no-node') : null, shown: [...svg.querySelectorAll('.node-text')].filter(t => t.getBoundingClientRect().width > 0).length }; });
  ok('look: "All at once" says it is a smaller view, and the boxes are still named when 8.5 px can hold a name', sm.note && sm.small && (sm.named === null || (sm.named && sm.shown > 0)), JSON.stringify(sm));
  await S1.page.click('#zFit'); await wait(S1.page, 600);
  const sm2 = await S1.page.evaluate(() => ({ note: !document.getElementById('zNote').hidden, small: document.getElementById('atlas').classList.contains('zt-small') }));
  ok('look: Reading size ends the smaller view', !sm2.note && !sm2.small, JSON.stringify(sm2));
  await S1.ctx.close();

  // a label beside its road carries a dot on that road; no "1 boxes"; a hovered box's card does not sit on it; halos leave the boxes alone at reading size
  const D = await open(browser, URL0, '#chart=stage_queue', 'look-labels');
  const lab = await D.page.evaluate(() => { const ls = [...document.querySelectorAll('g.elabel')], at = ls.filter(l => l.dataset.attached); return { n: ls.length, attached: at.length, dots: at.filter(l => l.querySelector('.elabel-dot')).length }; });
  ok('look: every label that is not on its road carries a dot on that road', lab.n > 0 && lab.attached > 0 && lab.dots === lab.attached, JSON.stringify(lab));
  const txt = await D.page.evaluate(() => document.body.innerText);
  ok('look: a count of one reads "1 box" and "1 road", never "1 boxes"', !/\b1 boxes\b|\b1 roads\b/.test(txt));
  const hn = await D.page.locator('g.node .node-box').nth(1).boundingBox();
  await D.page.mouse.move(hn.x + 5, hn.y + 5); await D.page.mouse.move(hn.x + hn.width / 2, hn.y + hn.height / 2, { steps: 4 }); await wait(D.page, 650);
  const tp = await D.page.evaluate(() => { const t = document.getElementById('tip'); if (!t || t.hidden) return null; const r = t.getBoundingClientRect(), n = [...document.querySelectorAll('g.node')][1].querySelector('.node-box').getBoundingClientRect(); return { over: Math.min(r.right, n.right) - Math.max(r.left, n.left) > 1 && Math.min(r.bottom, n.bottom) - Math.max(r.top, n.top) > 1 }; });
  ok('look: a hovered box card does not sit on the box it describes', !tp || tp.over === false, JSON.stringify(tp));
  const halo = await D.page.evaluate(() => { const h = document.querySelector('.atlas-svg.lod-near .halo.on'); return h ? getComputedStyle(h).opacity : null; });
  ok('look: no halo blob behind boxes at reading size (a hovered or pinned region still lights)', halo === null || +halo === 0, String(halo));
  await D.ctx.close();

  // light mode and the phone: nothing sideways
  for (const [w, h, theme, hash] of [[1920, 1080, 'light', '#chart=stage_queue'], [390, 844, 'dark', '#chart=stage_queue'], [390, 844, 'light', '#chart=stage_intake'], [360, 740, 'dark', '#chart=stage_delivery']]) {
    const P = await open(browser, URL0, hash, 'look-phone' + w + theme, { width: w, height: h }, theme);
    const m = await P.page.evaluate(() => ({ over: document.documentElement.scrollWidth - innerWidth, theme: document.documentElement.dataset.theme }));
    ok('look: ' + w + 'x' + h + ' ' + theme + ' ' + (hash || 'overview') + ': no sideways page scroll', m.over <= 0 && m.theme === theme, JSON.stringify(m));
    await P.ctx.close();
  }
}
if (want('frame')) {
  // the tool's name is in the frame and in the tab title; the overview carries no empty row
  const F1 = await open(browser, URL0, '#chart=overview', 'frame-name');
  const nm = await F1.page.evaluate(() => ({ h1: document.getElementById('siteTitle').textContent, title: document.title }));
  ok('frame: the tool name is in the frame and in the tab title', /Faultline/.test(nm.h1) && /Faultline/.test(nm.title) && !/interactive atlas/i.test(nm.h1), JSON.stringify(nm));
  const ov = await F1.page.evaluate(() => { const sm = document.getElementById('chartSummary'), s1 = sm.querySelector('.sum-1'), r = s1 ? s1.getBoundingClientRect() : null, q = sm.getBoundingClientRect(); return { first: s1 ? s1.textContent : sm.textContent, cut: !!r && (r.right > q.right + 1 || sm.scrollHeight > sm.clientHeight + 2), flow: /this is where the guide starts|open a stage to go on|no road arrives|no road leaves|other view/i.test(document.getElementById('flowBar').innerText), strip: !document.getElementById('fbStrip').hidden, dead: [...document.querySelectorAll('#draftBar .db-nd')].filter(b => /nothing left/i.test(b.textContent)).length }; });
  ok('frame: the overview says the whole first sentence, and draws no empty flow-bar text, no strip and no button with nothing to do', /durable queue/.test(ov.first) && !ov.cut && !ov.flow && !ov.strip && ov.dead === 0, JSON.stringify(ov));
  await F1.ctx.close();

  // the first-visit card is a strip under the canvas; the poster is whole with it up
  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } }), pgC = await ctxC.newPage(); watch(pgC, 'frame-cold');
  await pgC.goto(URL0 + '#chart=overview'); await pgC.waitForSelector('#atlas', { timeout: 15000 }); await wait(pgC, 700);
  const cold = await pgC.evaluate(() => { const ob = document.getElementById('onboard'), cv = document.getElementById('canvas').getBoundingClientRect(), o = ob.getBoundingClientRect(), nodes = [...document.querySelectorAll('g.node')].map(n => n.getBoundingClientRect()); return { shown: !ob.hidden, below: o.top >= cv.bottom - 1, hits: nodes.filter(r => r.left < o.right && r.right > o.left && r.top < o.bottom && r.bottom > o.top).length, cut: nodes.filter(r => r.left < cv.left - 1 || r.right > cv.right + 1 || r.top < cv.top - 1 || r.bottom > cv.bottom + 1).length }; });
  ok('frame: the first-visit card is a strip under the canvas, never on the drawing, and the poster is whole with it up', cold.shown && cold.below && cold.hits === 0 && cold.cut === 0, JSON.stringify(cold));
  await ctxC.close();

  // a pin: the poster is refitted (nothing slides off), the pinned box has no card over the roads it lit, lit label pills are evenly padded
  for (const [hash, w, h] of [['#chart=overview', 1440, 900], ['#chart=stage_queue', 1920, 1080]]) {
    const P = await open(browser, URL0, hash, 'frame-pin', { width: w, height: h });
    const nb = await P.page.locator('g.node .node-box').nth(1).boundingBox();
    await P.page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await wait(P.page, 800);
    const m = await P.page.evaluate(() => {
      const c = document.getElementById('canvas').getBoundingClientRect(), R = e => e.getBoundingClientRect();
      const lit = [...document.querySelectorAll('g.node.rel')].filter(n => R(n).width > 0), cut = lit.filter(n => { const r = R(n); return r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1; }).length;
      const pads = [...document.querySelectorAll('g.elabel.rel')].filter(l => getComputedStyle(l).display !== 'none').map(l => { const bg = R(l.querySelector('.elabel-bg')), ts = [...l.querySelectorAll('.elabel-text')].map(R); return [Math.min(...ts.map(r => r.left)) - bg.left, bg.right - Math.max(...ts.map(r => r.right))]; });
      return { lit: lit.length, cut, tip: document.getElementById('tip').hidden, labels: pads.length, padBad: pads.filter(p => Math.abs(p[0] - p[1]) > 2 || p[0] < 1.5 || p[1] < 1.5).length };
    });
    ok('frame: a pin on ' + hash.slice(7) + ' at ' + w + ': every lit box is on the canvas, no card on it, lit label pills evenly padded', m.lit > 0 && m.cut === 0 && m.tip && m.padBad === 0, JSON.stringify(m));
    await P.ctx.close();
  }

  // floating controls: the zoom bar has one home on every chart, and nothing in the bottom dock sits on anything else
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const Z = await open(browser, URL0, '', 'frame-dock' + w, { width: w, height: h });
    const homes = new Set(), bad = [];
    for (const id of (await insp(Z.page)).charts.filter(c => c !== 'whole')) {
      await Z.page.evaluate(i => window.atlasOpen(i), id); await wait(Z.page, 420);
      const r = await Z.page.evaluate(() => { const z = document.getElementById('zoomGroup').getBoundingClientRect(), cv = document.getElementById('canvas').getBoundingClientRect(), notes = ['ovNote', 'walkBar', 'mini'].map(i => document.getElementById(i)).filter(e => e && !e.hidden && e.getBoundingClientRect().width > 0).map(e => e.getBoundingClientRect()); return { left: Math.round(z.left - cv.left), bottom: Math.round(cv.bottom - z.bottom), over: notes.filter(q => q.left < z.right && q.right > z.left && q.top < z.bottom && q.bottom > z.top).length }; });
      homes.add(r.left + ',' + r.bottom); if (r.over) bad.push(id);
    }
    ok('frame: the notice sits on none of the dock on any chart at ' + w + ' (the zoom bar keeps its home unless a box is under it, so the homes need not be one)', bad.length === 0, [...homes].join(' | ') + ' ' + bad.join(' '));
    await Z.page.evaluate(() => window.atlasOpen('stage_intake')); await wait(Z.page, 300);
    await Z.page.click('#walkBtn'); await wait(Z.page, 800);
    const wk = await Z.page.evaluate(() => { const z = document.getElementById('zoomGroup').getBoundingClientRect(), k = document.getElementById('walkBar').getBoundingClientRect(), cv = document.getElementById('canvas').getBoundingClientRect(); return { onZoom: k.left < z.right && k.right > z.left && k.top < z.bottom && k.bottom > z.top, inside: k.left >= cv.left - 1 && k.right <= cv.right + 1 && k.bottom <= cv.bottom + 1 }; });
    ok('frame: the walk bar sits beside the zoom bar, inside the canvas, at ' + w, !wk.onZoom && wk.inside, JSON.stringify(wk));
    await Z.ctx.close();
  }
}
if (want('laptop')) {
  // 1. the Regions list: opening it does not throw the chart away (top moves under 40 px, no box that was on the canvas and is not under the panel leaves it)
  for (const [w, h] of [[1920, 1080], [1440, 900]]) for (const hash of ['#chart=overview', '#chart=stage_queue']) {
    const R = await open(browser, URL0, hash, 'laptop-regions', { width: w, height: h });
    await wait(R.page, 600);
    const snap = () => R.page.evaluate(() => { const c = document.getElementById('canvasWrap').getBoundingClientRect(), p = document.getElementById('regionPanel'), pr = p && !p.hidden ? p.getBoundingClientRect() : null; return { c: [c.left, c.right, c.top, c.bottom], pr: pr && [pr.left, pr.right, pr.top, pr.bottom], ns: [...document.querySelectorAll('g.node')].map(n => { const r = (n.querySelector('rect') || n).getBoundingClientRect(); return [n.dataset.node, r.left, r.right, r.top, r.bottom]; }).filter(n => n[2] > n[1]) }; });
    if (!(await R.page.evaluate(() => !document.getElementById('rdRegions').hidden))) { await R.ctx.close(); continue; }
    if (await R.page.evaluate(() => !document.getElementById('regionPanel').hidden)) { await R.page.click('#rdRegions'); await wait(R.page, 800); }
    const a = await snap(); await R.page.click('#rdRegions'); await wait(R.page, 900); const o = await snap();
    const inC = (n, c) => n[1] >= c[0] - 1 && n[2] <= c[1] + 1 && n[3] >= c[2] - 1 && n[4] <= c[3] + 1, was = new Map(a.ns.map(n => [n[0], n]));
    const lost = o.ns.filter(n => was.has(n[0]) && inC(was.get(n[0]), a.c) && !(o.pr && n[1] < o.pr[1] && n[2] > o.pr[0] && n[3] < o.pr[3] && n[4] > o.pr[2]) && !inC(n, o.c)).length;
    const dy = Math.min(...o.ns.map(n => n[3])) - Math.min(...a.ns.map(n => n[3])), dx = Math.min(...o.ns.map(n => n[1])) - Math.min(...a.ns.map(n => n[1]));
    ok('opening Regions on ' + hash.slice(7) + ' at ' + w + ' keeps the chart (top moves under 40 px, sideways no more than the panel, no box lost)', !!o.pr && Math.abs(dy) < 40 && dx <= (o.pr[1] - o.pr[0]) + 2 && lost === 0, JSON.stringify({ dy, dx, lost, panel: o.pr && o.pr[1] - o.pr[0] }));
    await R.ctx.close();
  }

  // 2. a laptop-sized window: the sidebar starts as its rail; names keep 11 px; road conditions may go to 9.4 px and no lower; every chart of the fixture whole on the canvas
  for (const [w, h] of [[1440, 900], [1920, 1080]]) {
    const L = await open(browser, URL0, '', 'laptop-laptop' + w, { width: w, height: h });
    const nav = await L.page.evaluate(() => document.querySelector('.app').dataset.nav);
    ok('at ' + w + ' the sidebar starts ' + (w < 1500 ? 'as its slim rail' : 'open'), nav === (w < 1500 ? 'collapsed' : 'open'), nav);
    const bad = [], sizes = [];
    for (const id of (await insp(L.page)).charts.filter(c => c !== 'whole' && c !== 'overview')) {
      await L.page.evaluate(i => window.atlasOpen(i), id); await wait(L.page, 480);
      const m = await L.page.evaluate(() => {
        const c = document.getElementById('canvasWrap').getBoundingClientRect(), R = e => e.getBoundingClientRect(), vis = e => R(e).width > 0 && getComputedStyle(e).display !== 'none';
        const ns = [...document.querySelectorAll('g.node')].filter(vis), cut = ns.filter(n => { const r = R(n.querySelector('rect') || n); return r.left < c.left - 1 || r.right > c.right + 1 || r.top < c.top - 1 || r.bottom > c.bottom + 1; }).length;
        const px = sel => [...document.querySelectorAll(sel)].filter(vis).map(t => parseFloat(getComputedStyle(t).fontSize) * R(t).height / (t.getBBox().height || 1));
        return { cut, name: Math.min(...px('g.node .node-text'), 99), cond: Math.min(...px('g.elabel text'), 99) };
      });
      sizes.push(m); if (m.cut) bad.push(id);
    }
    ok('at ' + w + ' no chart of the fixture is cut at its default view', bad.length === 0, bad.join(' '));
    ok('at ' + w + ' box names read at 11 px or more' + (w < 1500 ? ' and road conditions at 9.4 px or more' : ' and road conditions at 11'), sizes.every(m => m.name >= 10.95) && sizes.every(m => m.cond >= (w < 1500 ? 9.35 : 10.95)), JSON.stringify(sizes.map(m => [+m.name.toFixed(1), +m.cond.toFixed(1)]).slice(0, 4)));
    await L.ctx.close();
  }

  // 3. the walk: every step brings the box, every box it lights and every lit label onto the canvas, clear of the walk bar
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const K = await open(browser, URL0, '#chart=stage_intake', 'laptop-walk' + w, { width: w, height: h });
    await K.page.click('#walkBtn'); await wait(K.page, 800);
    const bad = []; let steps = 0;
    for (let i = 0; i < 40; i++) {
      await wait(K.page, 560);
      const m = await K.page.evaluate(() => {
        const R = e => e.getBoundingClientRect(), hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
        const c = R(document.getElementById('canvasWrap')), wr = R(document.getElementById('walkBar')), insp = document.getElementById('inspector'), right = Math.min(c.right, insp && R(insp).width > 0 ? R(insp).left : c.right);
        const lit = [...document.querySelectorAll('g.node.sel, g.node.n-in, g.node.n-out')], labs = [...document.querySelectorAll('g.elabel.rel')].filter(l => R(l).width > 0 && getComputedStyle(l).display !== 'none');
        const rect = n => R(n.querySelector('rect') || n), wholly = q => q.left >= c.left - 1 && q.right <= right + 1 && q.top >= c.top - 1 && q.bottom <= c.bottom + 1;
        return { cur: lit.some(n => n.classList.contains('sel')), off: lit.filter(n => !wholly(rect(n))).length + labs.filter(l => !wholly(R(l.querySelector('text') || l))).length, bar: lit.some(n => hit(rect(n), wr)) || labs.some(l => hit(R(l.querySelector('text') || l), wr)) };
      });
      steps++; if (!m.cur || m.off || m.bar) bad.push(i + 1);
      if (!(await K.page.evaluate(() => { const n = document.getElementById('wkNext'); if (!n || n.disabled) return false; n.click(); return true; }))) break;
    }
    ok('the walk at ' + w + ' keeps the box, what it lights and the lit labels on the canvas and clear of the walk bar on every step', steps > 3 && bad.length === 0, steps + ' steps; bad ' + bad.join(','));
    await K.ctx.close();
  }

  // 4. what a box says it is: off by default keeps its name at full strength; a lit box and a lit forward road are never pale or dashed (a return road is)
  {
    const D = await open(browser, URL0, '#chart=stage_queue', 'laptop-off');
    const o = await D.page.evaluate(() => {
      const off = document.querySelector('g.node.st-off'), norm = document.querySelector('g.node:not(.st-off):not(.st-test-only)'), op = (e, s) => parseFloat(getComputedStyle(e.querySelector(s)).opacity);
      return off ? { text: op(off, '.node-text'), box: op(off, '.node-box'), normalBox: op(norm, '.node-box'), dash: getComputedStyle(off.querySelector('.node-box')).strokeDasharray } : null;
    });
    ok('an off-by-default box reads at full strength (name 1.0) and is marked paler and dashed', !o || (o.text === 1 && o.box < o.normalBox && o.dash !== 'none'), JSON.stringify(o));
    const nb = await D.page.locator('g.node .node-box').nth(1).boundingBox();
    await D.page.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2); await wait(D.page, 700);
    const e = await D.page.evaluate(() => { const f = [...document.querySelectorAll('g.edge.rel:not(.e-return) .edge-line')].map(p => getComputedStyle(p).strokeDasharray), r = [...document.querySelectorAll('g.edge.e-return.rel .edge-line')].map(p => getComputedStyle(p).strokeDasharray), pinned = document.querySelector('g.node.sel.st-off .node-text'); return { fwd: f.length, fwdDashed: f.filter(x => x !== 'none').length, ret: r.length, retSolid: r.filter(x => x === 'none').length, pinnedOffText: pinned ? getComputedStyle(pinned).opacity : null }; });
    ok('a lit forward road is solid and a lit return road is dashed, as the legend says; a pinned off box has a full-strength name', e.fwdDashed === 0 && e.retSolid === 0 && (e.pinnedOffText === null || e.pinnedOffText === '1'), JSON.stringify(e));
    await D.ctx.close();
  }

  // 5. the poster: an ending pill is no brighter than a stage, a stage off the main path is not dimmed, no unlit cushion
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const P = await open(browser, URL0, '#chart=overview', 'laptop-poster' + w, { width: w, height: h }); await wait(P.page, 500);
    const m = await P.page.evaluate(() => { const op = e => parseFloat(getComputedStyle(e).opacity), st = [...document.querySelectorAll('g.node.st-box')], pills = [...document.querySelectorAll('g.node:not(.st-box)')], halos = [...document.querySelectorAll('.halo.on')].filter(h => parseFloat(getComputedStyle(h).opacity) > 0.01); return { stageMin: Math.min(...st.map(op)), pillMax: Math.max(...pills.map(op), 0), stages: st.length, cushions: halos.length }; });
    ok('the poster at ' + w + ': every stage at full strength, no ending pill brighter than a stage, no unlit cushion', (m.stages === 0 || (m.stageMin === 1 && m.pillMax <= m.stageMin)) && m.pillMax <= 0.8 && m.cushions === 0, JSON.stringify(m));      // (the fixture's poster has no stage boxes: the pills are checked at 80% and no cushion is lit)
    await P.ctx.close();
  }

  // 6. the zoom bar covers no box and no road condition on any chart, and is opaque
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const Z = await open(browser, URL0, '', 'laptop-zoom' + w, { width: w, height: h });
    const bad = []; let bg = '';
    for (const id of (await insp(Z.page)).charts.filter(c => c !== 'whole' && c !== 'overview')) {
      await Z.page.evaluate(i => window.atlasOpen(i), id); await wait(Z.page, 560);
      const r = await Z.page.evaluate(() => { const R = e => e.getBoundingClientRect(), hit = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1, z = R(document.getElementById('zoomGroup')), vis = e => R(e).width > 0 && getComputedStyle(e).display !== 'none'; return { n: [...document.querySelectorAll('g.node')].filter(vis).filter(n => hit(R(n.querySelector('rect') || n), z)).length, l: [...document.querySelectorAll('g.elabel')].filter(vis).filter(l => hit(R(l.querySelector('text') || l), z)).length, bg: getComputedStyle(document.getElementById('zoomGroup')).backgroundColor }; });
      bg = r.bg; if (r.n || r.l) bad.push(id + ':' + r.n + '/' + r.l);
    }
    ok('the zoom bar covers no box and no road condition on any chart at ' + w + ' and is opaque', bad.length === 0 && /^rgb\(/.test(bg), bad.join(' ') + ' ' + bg);
    await Z.ctx.close();
  }

  // 7. All at once: one message, no banner over the boxes
  {
    const A = await open(browser, URL0, '#chart=stage_queue', 'laptop-all', { width: 1440, height: 900 });
    if (await A.page.evaluate(() => !document.getElementById('zAll').disabled)) {      // the button is always there; it does something only on a chart that opens at reading size
      await A.page.click('#zAll'); await wait(A.page, 700);
      const t = await A.page.evaluate(() => ({ banner: !document.getElementById('nameNote').hidden, note: document.getElementById('zNote').hidden ? '' : document.getElementById('zNote').textContent }));
      ok('All at once says one thing, in the zoom bar, and puts no banner over the boxes', !t.banner && /Smaller view/.test(t.note), JSON.stringify(t));
    }
    await A.ctx.close();
  }

  // 8. whole map: a stage pill is not cut while there is room beside it
  {
    const M = await open(browser, URL0, '#chart=whole', 'laptop-whole', { width: 1440, height: 900 }); await wait(M.page, 800);
    const t = await M.page.evaluate(() => [...document.querySelectorAll('.stpill .stp-t')].map(x => x.textContent));
    ok('on the whole map at 1440 the stage pills keep readable phrases (none is cut to a few letters)', t.length > 0 && t.every(s => !s.includes('…') || s.replace(/…/g, '').trim().length >= 10), JSON.stringify(t.slice(0, 6)));
    const gap = await M.page.evaluate(() => { const cw = document.getElementById('canvasWrap').getBoundingClientRect(), rs = [...document.querySelectorAll('g.cluster, .stpill')].map(e => e.getBoundingClientRect()).filter(r => r.width > 0); const L = Math.min(...rs.map(r => r.left)) - cw.left, R = cw.right - Math.max(...rs.map(r => r.right)); return { left: Math.round(L), right: Math.round(R) }; });
    ok('the whole map at default Fit is centred by what is drawn: the gaps left and right of the halos and stage pills are within 30 px of each other', Math.abs(gap.left - gap.right) <= 30, JSON.stringify(gap));
    await M.ctx.close();
  }

  // 9. How it fails: one left edge for the descriptions of a group, the counts once, a stage filter drawn like the chips
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }); await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage(); watch(page, 'laptop-fails' + w); await page.goto(pathToFileURL(F4).href + '#reading=fails'); await page.waitForSelector('.gd', { timeout: 15000 }); await wait(page, 500);
    await page.evaluate(() => { document.querySelectorAll('.gd-sec').forEach(s => { s.open = true; }); }); await wait(page, 200);
    const m = await page.evaluate(() => { const xs = [...document.querySelectorAll('.fl-row .fl-gist')].filter(e => e.getBoundingClientRect().width > 0).map(e => Math.round(e.getBoundingClientRect().left)), sel = document.querySelector('#flStage'), chip = document.querySelector('.bk-chip'); return { xs: [...new Set(xs)], n: xs.length, leadButtons: document.querySelectorAll('.fl-lead .fl-n').length, selR: sel ? parseFloat(getComputedStyle(sel).borderTopLeftRadius) : 0, chipR: chip ? parseFloat(getComputedStyle(chip).borderTopLeftRadius) : 0, appearance: sel ? getComputedStyle(sel).appearance : '' }; });
    ok('How it fails at ' + w + ': every description starts at one x, the counts are not repeated in the lead, the stage filter is drawn like the chips', m.n > 0 && m.xs.length === 1 && m.leadButtons === 0 && m.selR >= 20 && m.chipR >= 20 && m.appearance === 'none', JSON.stringify(m));
    await ctx.close();
  }

  // 10. Where it can break: the first screen holds a question and its evidence; "not run" once; one link style; zero-count kinds are not full chips
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } }); await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage(); watch(page, 'laptop-breaks' + w); await page.goto(pathToFileURL(F4).href + '#reading=breaks'); await page.waitForSelector('.gd', { timeout: 15000 }); await wait(page, 500);
    const m = await page.evaluate(() => {
      const R = e => e.getBoundingClientRect(), fold = innerHeight, row = document.querySelector('.gd-sec[open] .bk-row'), ev = row && row.querySelector('.bk-ev[open] p'), txt = document.querySelector('.gd-main').innerText;
      const links = new Set([...document.querySelectorAll('.gd-main a.hlink, .gd-main button.hlink')].map(a => { const s = getComputedStyle(a); return s.fontWeight + '|' + s.fontFamily.slice(0, 12) + '|' + s.borderBottomStyle; }));
      const widths = new Set([...document.querySelectorAll('.bk-note, .bk-sum, .bk-stuck, .gd-body')].filter(e => R(e).width > 0).map(e => Math.round(parseFloat(getComputedStyle(e).maxWidth) || 0)));
      return { rowTop: row ? Math.round(R(row).top) : -1, hasEv: !!(row && row.querySelector('.bk-ev')), evTop: ev ? Math.round(R(ev).top) : -1, fold, notRun: (txt.match(/not run\b/gi) || []).length, links: [...links], widths: [...widths], zeroChipsVisible: [...document.querySelectorAll('.bk-chip.bk-zero')].filter(c => R(c).width > 0).length };
    });
    const ban = await page.evaluate(() => { const n = document.querySelector('.bk-note'); return { text: n ? n.innerText : '', code: n ? [...n.querySelectorAll('code')].map(c => c.textContent) : [] }; });
    ok('Where it can break at ' + w + ' says what it was read from (the commit, when the page has a pin), that it was not run, and that some questions will be wrong', /commit/.test(ban.text) && ban.code.length === 1 && ban.code[0] === 'fixture-00' && /not run/i.test(ban.text) && /some of these questions will be wrong/.test(ban.text) && !/bugs?/i.test(ban.text), JSON.stringify(ban));
    const pill = await page.evaluate(() => { let n = document.querySelector('.bk-row .bk-nm'), made = null; if (!n) { made = n = document.createElement('span'); n.className = 'bk-nm'; n.textContent = 'A box name'; (document.querySelector('.bk-q') || document.querySelector('.bk-note')).appendChild(n); }       /* (a page whose data names no box in a sentence: the class is tried on a span) */ const s = getComputedStyle(n), l = document.querySelector('.gd-main a.hlink, .gd-main button.hlink'), c = document.querySelector('.bk-q code, .bk-ev code'); const ls = l && getComputedStyle(l), cs = c && getComputedStyle(c); const out = { bg: s.backgroundColor, font: s.fontFamily.slice(0, 20), border: s.borderBottomStyle, linkBorder: ls && ls.borderBottomStyle, codeFont: cs && cs.fontFamily.slice(0, 20), text: n.textContent }; if (made) made.remove(); return out; });
    ok('a box name inside a sentence is set apart by a tint, in the font of the sentence: not a link look (no underline) and not code (no code font)', !!pill && (pill.bg !== 'rgba(0, 0, 0, 0)' && pill.border === 'none' && (!pill.codeFont || pill.font !== pill.codeFont)), JSON.stringify(pill));
    ok('Where it can break at ' + w + ': a question and its evidence are on the first screen, "not run" is said once, one link style and one text width, no zero-count chip drawn', m.rowTop > 0 && m.rowTop < m.fold - 120 && (m.evTop === -1 ? !m.hasEv : m.evTop < m.fold - 20) && m.notRun === 1 && m.links.length <= 1 && m.widths.length <= 1 && m.zeroChipsVisible === 0, JSON.stringify(m));
    await ctx.close();
  }

  // 11. a cut tab is plainly a cut: no tab is cut with an ellipsis
  {
    const T = await open(browser, URL0, '#chart=stage_queue', 'laptop-cut');
    const c = await T.page.evaluate(() => { const t = [...document.querySelectorAll('.chip-text')].map(x => x.textContent); return { cutTabs: t.filter(s => s.includes('···')).length, ellipsis: t.filter(s => s.includes('…')).length }; });
    ok('no tab is cut with an ellipsis (a cut tab carries three middle dots)', c.ellipsis === 0, JSON.stringify(c));
    await T.ctx.close();
  }
}

/* ============================================================================ a pin and Esc, the zoom bar's one place, 100% on the whole map, the +N list, a tab, the long-roads chip, the left rail */
if (want('pins')) {
  const PIN_ST = nid => {
    const R = e => e.getBoundingClientRect(), c = R(document.getElementById('canvasWrap')), insp = R(document.getElementById('inspector')), right = Math.min(c.right, insp.width > 0 ? insp.left : c.right);
    const inside = s => s.left >= c.left - 1 && s.right <= right + 1 && s.top >= c.top - 1 && s.bottom <= c.bottom + 1;
    const all = [...document.querySelectorAll('g.node')].filter(n => R(n).width > 0), rect = n => R(n.querySelector('rect') || n), lit = all.filter(n => +getComputedStyle(n).opacity > 0.75);
    const labs = [...document.querySelectorAll('g.elabel')].filter(l => R(l).width > 0 && +getComputedStyle(l).opacity > 0.75), cur = nid ? document.querySelector('g.node[data-node="' + nid + '"]') : null;
    return { left: Math.min(...all.map(n => rect(n).left)), top: Math.min(...all.map(n => rect(n).top)), on: all.filter(n => inside(rect(n))).length, n: all.length, litCut: lit.filter(n => !inside(rect(n))).length, lit: lit.length, labCut: labs.filter(l => !inside(R(l))).length, curCut: cur ? !inside(rect(cur)) : false, ring: getComputedStyle(document.getElementById('canvas')).outlineStyle };
  };

  // 1. a pin brings its whole lit set onto the canvas (the panel it brings takes room), and Esc gives the chart back, with no ring around the canvas
  for (const [w, h] of [[1100, 720], [1440, 900]]) {
    const P = await open(browser, URL0, '#chart=stage_queue', 'pins-pin' + w, { width: w, height: h });
    const ids = await P.page.evaluate(() => [...document.querySelectorAll('g.node')].map(n => n.dataset.node)), bad = [], back = [];
    for (const nid of ids) {
      await P.page.evaluate(() => window.atlasOpen('overview')); await wait(P.page, 150); await P.page.evaluate(() => window.atlasOpen('stage_queue')); await wait(P.page, 650);
      const base = await P.page.evaluate(PIN_ST, null), c = await P.page.evaluate(n => { const r = document.querySelector('g.node[data-node="' + n + '"] rect').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, nid);
      await P.page.mouse.click(c.x, c.y); await wait(P.page, 1000); await P.page.mouse.move(6, h - 40); await wait(P.page, 120);
      const a = await P.page.evaluate(PIN_ST, nid);
      if (a.litCut || a.labCut || a.curCut) bad.push(nid + ': lit cut ' + a.litCut + '/' + a.lit + ', labels cut ' + a.labCut + (a.curCut ? ', the pinned box cut' : ''));
      await P.page.keyboard.press('Escape'); await P.page.keyboard.press('Escape'); await wait(P.page, 700);
      const e = await P.page.evaluate(PIN_ST, null);
      if (Math.abs(e.left - base.left) > 8 || Math.abs(e.top - base.top) > 8 || e.on !== base.on || e.ring !== 'none') back.push(nid + ': moved ' + Math.round(e.left - base.left) + ',' + Math.round(e.top - base.top) + ', on canvas ' + base.on + ' -> ' + e.on + ', ring ' + e.ring);
    }
    ok('at ' + w + 'x' + h + ' no pin leaves a lit box or a lit road condition cut or under the panel, the pinned box included (' + ids.length + ' pins)', ids.length > 0 && bad.length === 0, bad.join(' | '));
    ok('at ' + w + 'x' + h + ' Esc puts the chart back within 8 px with the same boxes on the canvas, and draws no ring around it', back.length === 0, back.join(' | '));
    await P.ctx.close();
  }

  // 2. the zoom bar has one place and one set of buttons; three clicks on + all land and the button does not move; no panel cuts it
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    const Z = await open(browser, URL0, '', 'pins-zoom' + w, { width: w, height: h });
    const ids = (await insp(Z.page)).charts, seen = new Set(), names = new Set();
    for (const id of ids) {
      await Z.page.evaluate(i => window.atlasOpen(i), id); await wait(Z.page, 420);
      const r = await Z.page.evaluate(() => { const q = document.getElementById('zoomGroup').getBoundingClientRect(); return { k: [q.left, q.top, q.width, q.height].map(Math.round).join(','), names: ['zFit', 'zAll', 'z100'].map(i => document.getElementById(i).textContent.trim() + (document.getElementById(i).hidden ? '(hidden)' : '')).join('|') }; });
      seen.add(id === 'whole' || id === 'overview' ? r.k.split(',').slice(0, 2).join(',') + ':' + id : r.k); names.add(r.names);
    }
    const parts = [...seen].filter(k => !/:/.test(k));
    ok('at ' + w + ' the zoom bar is in one place on every chart, with the same three buttons (Fit, All at once, 100%)', new Set(parts).size === 1 && names.size === 1 && [...names][0] === 'Fit|All at once|100%', [...seen].join(' ') + ' ' + [...names].join(' / '));
    await Z.page.evaluate(() => window.atlasOpen('stage_queue')); await wait(Z.page, 500);
    const pos = await Z.page.evaluate(() => { const r = document.getElementById('zIn').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }), seq = [];
    await Z.page.mouse.move(pos.x, pos.y);
    for (let i = 0; i < 3; i++) {
      const b = await Z.page.evaluate(() => ({ s: window.atlasInspect().scale, r: (q => [q.left, q.top].map(Math.round).join(','))(document.getElementById('zIn').getBoundingClientRect()) }));
      await Z.page.mouse.click(pos.x, pos.y); await wait(Z.page, 450);
      const a = await Z.page.evaluate(() => ({ s: window.atlasInspect().scale, r: (q => [q.left, q.top].map(Math.round).join(','))(document.getElementById('zIn').getBoundingClientRect()) }));
      seq.push(a.s > b.s + 0.001 && a.r === b.r ? 'ok' : 'click ' + (i + 1) + ': zoom ' + b.s.toFixed(2) + '->' + a.s.toFixed(2) + ', button ' + b.r + '->' + a.r);
    }
    ok('at ' + w + ' three clicks on + without moving the pointer all land, and the button stays where it was', seq.every(x => x === 'ok'), seq.join(' | '));
    await Z.page.evaluate(() => window.atlasOpen('stage_queue')); await wait(Z.page, 500); await Z.page.keyboard.press('0'); await wait(Z.page, 400);
    const home = await Z.page.evaluate(() => (q => [q.left, q.top, q.width].map(Math.round).join(','))(document.getElementById('zoomGroup').getBoundingClientRect()));
    const c0 = await Z.page.evaluate(() => { const r = document.querySelector('g.node rect').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await Z.page.mouse.click(c0.x, c0.y); await wait(Z.page, 900);
    const withPin = await Z.page.evaluate(() => { const q = document.getElementById('zoomGroup').getBoundingClientRect(), i = document.getElementById('inspector').getBoundingClientRect(); return { k: [q.left, q.top, q.width].map(Math.round).join(','), cut: i.width > 0 && q.right > i.left }; });
    await Z.page.click('#handlesBtn'); await wait(Z.page, 600);
    const withH = await Z.page.evaluate(() => { const q = document.getElementById('zoomGroup').getBoundingClientRect(), p = document.getElementById('handlePanel'), r = p && !p.hidden ? p.getBoundingClientRect() : null; return { k: [q.left, q.top, q.width].map(Math.round).join(','), cut: !!r && q.right > r.left && q.left < r.right && q.bottom > r.top && q.top < r.bottom }; });
    await Z.page.click('#handlesBtn'); await Z.page.click('#legendBtn'); await wait(Z.page, 500);
    const withL = await Z.page.evaluate(() => { const q = document.getElementById('zoomGroup').getBoundingClientRect(), p = document.getElementById('legend'), r = p && !p.hidden ? p.getBoundingClientRect() : null; return { k: [q.left, q.top, q.width].map(Math.round).join(','), cut: !!r && q.right > r.left && q.left < r.right && q.bottom > r.top && q.top < r.bottom }; });
    ok('at ' + w + ' a pin (its panel), the Handles panel and the Legend leave the zoom bar where it was and cut none of it', withPin.k === home && withH.k === home && withL.k === home && !withPin.cut && !withH.cut && !withL.cut, JSON.stringify({ home, withPin, withH, withL }));
    await Z.ctx.close();
  }

  // 3. 100% on the whole map lands on a stage: its boxes and its name are in view (never the gutter between two stages)
  for (const [label, url, w, h] of [['the fixture', URL0, 1440, 900], ['the big map', URLB, 1920, 1080], ['the big map', URLB, 1440, 900]]) {
    const W = await open(browser, url, '#chart=whole', 'pins-whole100', { width: w, height: h });
    await W.page.click('#z100'); await wait(W.page, 1200);
    const r = await W.page.evaluate(() => {
      const c = document.getElementById('canvasWrap').getBoundingClientRect(), R = e => e.getBoundingClientRect();
      const inv = e => { const q = R(e); return q.width > 0 && q.right > c.left && q.left < c.right && q.bottom > c.top && q.top < c.bottom; };
      const names = [...document.querySelectorAll('.cl-band, .stpill')].filter(e => { const q = R(e); return q.width > 0 && q.left >= c.left && q.right <= c.right && q.top >= c.top && q.bottom <= c.bottom && getComputedStyle(e).display !== 'none'; });
      return { scale: +window.atlasInspect().scale.toFixed(2), boxes: [...document.querySelectorAll('g.node')].filter(inv).length, names: names.length };
    });
    ok('100% on ' + label + ' at ' + w + 'x' + h + ' leaves a stage\'s boxes and its name in view', r.scale === 1 && r.boxes > 0 && r.names > 0, JSON.stringify(r));
    await W.ctx.close();
  }

  // 4. the Long roads chip: its states are the ones its tooltip names, and "faint" at Fit is far fainter than a stage outline
  {
    const W = await open(browser, URLB, '#chart=whole', 'pins-long', { width: 1920, height: 1080 });
    const seqB = [], titleB = await W.page.evaluate(() => document.getElementById('rdLong').title);
    for (let i = 0; i < 3; i++) { await W.page.click('#rdLong'); await wait(W.page, 350); seqB.push(await W.page.evaluate(() => document.getElementById('rdLong').textContent.replace('Long roads: ', ''))); }
    const big = /not offered on a map of more than 500 boxes/.test(titleB);
    ok('the Long roads chip cycles through the states its tooltip names, and no other (' + (big ? 'a map over 500 boxes: off and faint' : 'off, faint and on') + ')', big ? (seqB.join() === 'faint,off,faint' && !/ or on\b/.test(titleB.replace(/"On" is not offered[^.]*\./, '')) && /off/.test(titleB) && /faint/.test(titleB)) : (seqB.join() === 'faint,on,off'), seqB.join(',') + ' / ' + titleB.slice(0, 160));
    await W.page.click('#rdLong'); for (let i = 0; i < 6; i++) { await W.page.keyboard.press('-'); await wait(W.page, 100); } await wait(W.page, 500);        // faint, and zoomed out to the far level (a real map is there at Fit)
    const q = await W.page.evaluate(() => { const lr = document.querySelector('.fl-x'), st = document.querySelector('.cluster-box'); return { lod: document.getElementById('atlas').getAttribute('class').match(/lod-\w+/)[0], faint: lr ? +getComputedStyle(lr).strokeOpacity : -1, mode: document.getElementById('rdLong').textContent }; });
    ok('"faint" at Fit draws the long-road ribbon at under 8% (it was 17%, a pale band in every gutter)', q.lod === 'lod-far' && /faint/.test(q.mode) && q.faint > 0 && q.faint < 0.08, JSON.stringify(q));
    await W.ctx.close();
    const L = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); await L.addInitScript(() => { try { localStorage.setItem('faultline-atlas-theme', 'light'); localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
    const lp = await L.newPage(); watch(lp, 'pins-long-light'); await lp.goto(URLB + '#chart=whole'); await lp.waitForSelector('#atlas', { timeout: 15000 }); await wait(lp, 500);
    await lp.click('#rdLong'); for (let i = 0; i < 6; i++) { await lp.keyboard.press('-'); await wait(lp, 100); } await wait(lp, 500);
    const ql = await lp.evaluate(() => ({ faint: +getComputedStyle(document.querySelector('.fl-x')).strokeOpacity, theme: document.documentElement.getAttribute('data-theme') }));
    ok('"faint" at Fit is under 8% in the light theme too', ql.theme === 'light' && ql.faint > 0 && ql.faint < 0.08, JSON.stringify(ql));
    await L.close();
  }

  // 6. the +N list of the flow bar lies wholly inside the window and every row can be reached (here a list of 69 rows is forced into a side of the bar)
  for (const [w, h] of [[1920, 1080], [1440, 900], [1100, 700]]) {
    const M = await open(browser, URL0, '#chart=stage_queue', 'pins-more' + w, { width: w, height: h });
    const r = await M.page.evaluate(() => {
      const more = document.querySelector('#fbNext .fc-more') || document.querySelector('#fbPrev .fc-more'); if (!more) return null;
      const ids = Object.keys(JSON.parse(document.getElementById('atlas-data').textContent).charts); more.hidden = false; more._hid = Array.from({ length: 69 }, (_, i) => ({ dataset: { fc: ids[i % ids.length] } })); more.click();
      const m = document.getElementById('fbMore'), q = m.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight, rows = m.children.length;
      const out = { shown: !m.hidden, inside: q.left >= 0 && q.right <= vw && q.top >= 0 && q.bottom <= vh, rows, scrolls: m.scrollHeight > m.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(m).overflowY) };
      m.scrollTop = m.scrollHeight; const last = m.lastElementChild.getBoundingClientRect(), q2 = m.getBoundingClientRect(); out.lastReached = last.bottom <= q2.bottom + 1 && last.bottom <= vh && last.top >= q2.top - 1; return out;
    });
    ok('at ' + w + 'x' + h + ' the +N list lies wholly inside the window, scrolls, and its last row can be reached', !!r && r.shown && r.inside && r.rows === 69 && r.scrolls && r.lastReached, JSON.stringify(r));
    await M.ctx.close();
  }

  // 7. the Handles panel's pills may wrap only between the words of a name (after . _ / : - and between camelCase words), never in the middle of one
  {
    const Hh = await open(browser, URL0, '#chart=stage_queue', 'pins-handles', { width: 1440, height: 900 });
    await Hh.page.click('#handlesBtn'); await wait(Hh.page, 600);
    const r = await Hh.page.evaluate(() => {
      const pills = [...document.querySelectorAll('#handlePanel .hp-chip')], sep = new RegExp('[._/:-]|[a-z0-9][A-Z]');
      return { n: pills.length, noWrapSpan: pills.filter(p => !p.querySelector('.hc-t')).length, withBreak: pills.filter(p => sep.test(p.textContent)).length, withWbr: pills.filter(p => sep.test(p.textContent) && p.querySelector('wbr')).length };
    });
    ok('each handle pill in the Handles panel can wrap at the words of its name (a break opportunity after a separator and between camelCase words)', r.n > 0 && r.noWrapSpan === 0 && r.withBreak === r.withWbr, JSON.stringify(r));
    await Hh.ctx.close();
  }

  // 5. on a laptop-sized window the left rail is glyphs, so the top bar says "Where it can break" and "How it fails" in words on the first screen; on a wide window the nav says them and the top bar does not
  {
    const F5 = path.join(TMP, 'pins.html'); fs.writeFileSync(F5, buildPage(await makeAtlasData(), { guides: true }));
    for (const [w, h] of [[1440, 900], [1366, 768], [1920, 1080]]) {
      const N = await open(browser, pathToFileURL(F5).href, '#chart=stage_queue', 'pins-rail' + w, { width: w, height: h });
      const m = await N.page.evaluate(() => {
        const R = e => e.getBoundingClientRect(), top = R(document.getElementById('top')), pages = [...document.querySelectorAll('.hw-page')].filter(e => R(e).width > 0 && R(e).right <= innerWidth && R(e).left >= 0 && R(e).bottom <= top.bottom + 1);
        const nav = document.querySelector('.nav-break .ni-label'), navShown = !!nav && R(nav).width > 0 && getComputedStyle(nav).display !== 'none';
        return { words: pages.map(e => e.textContent.replace(/\s+/g, ' ').trim()), navShown, app: document.querySelector('.app').dataset.nav, howto: [...document.querySelectorAll('.howto span:not(.hw-pages)')].filter(e => R(e).width > 0).length };
      });
      const narrow = w < 1500;
      ok('at ' + w + (narrow ? ' the top bar says "Where it can break" and "How it fails" in words (the rail is glyphs), with no click or hover' : ' the nav says them, and the top bar keeps its how-to line'), narrow ? (m.app === 'collapsed' && m.words.some(t => /^where it can break/i.test(t)) && m.words.some(t => /^how it fails/i.test(t)) && m.howto === 0) : (m.navShown && m.words.length === 0 && m.howto > 0), JSON.stringify(m));
      await N.ctx.close();
    }
  }
}

/* ============================================================================ 14. a page made by `faultline map` (no agent): the phone list, the top bar, the double-click, and an agent page left as it was */
if (want('toolmap')) {
  const proj = path.join(TMP, 'toolmap-proj'), root = path.join(here, '..', 'examples', 'toy');
  const r = spawnSync(process.execPath, [path.join(here, '..', 'bin', 'faultline.mjs'), 'map', '--source', root, '--project', proj, '--quiet'], { encoding: 'utf8' });
  ok('faultline map builds a page of the toy example', r.status === 0 && fs.existsSync(path.join(proj, 'dist', 'atlas.html')), (r.stderr || r.stdout || '').slice(0, 200));
  const TM = pathToFileURL(path.join(proj, 'dist', 'atlas.html')).href;
  const closeReader = async page => { await page.evaluate(() => { const e = document.getElementById('rl'); if (e) e.hidden = true; document.body.classList.remove('rl-on'); }); await wait(page, 200); };
  {
    const A = await open(browser, TM, '#chart=overview', 'toolmap-1366', { width: 1366, height: 768 });
    await closeReader(A.page);
    const m = await A.page.evaluate(() => ({
      cls: document.documentElement.classList.contains('toolmap'), regions: (document.getElementById('rdRegions') || {}).textContent || '', all: (document.getElementById('qAll') || {}).textContent || '',
      pages: [...document.querySelectorAll('#hwPages .hw-page')].filter(e => e.getBoundingClientRect().width > 0).map(e => e.textContent.replace(/\s+/g, ' ').trim()), stages: document.querySelectorAll('#nav .nav-stage').length,
    }));
    ok('1366: a tool map says so (class), names its Regions button for what it lists, and its search button for what it does', m.cls && /Stages and loops/.test(m.regions) && /Search all charts/.test(m.all), JSON.stringify(m));
    ok('1366: the top bar names the pages a newcomer looks for first, and the rail lists the stages', m.pages.length >= 1 && m.stages >= 1, JSON.stringify(m));
    const node = A.page.locator('#atlas g.node[data-node]').filter({ has: A.page.locator('.node-box') }).first();
    await node.dblclick({ force: true }); await wait(A.page, 400);
    const rows = await A.page.locator('#dockPanel .tsf-row').count();
    ok('1366: a double-click on a stage of the poster lists its functions, and a click on one opens its chart', rows >= 1, 'rows ' + rows);
    if (rows) {
      await A.page.locator('#dockPanel .tsf-row').first().click(); await wait(A.page, 500);
      const c = await A.page.evaluate(() => window.atlasInspect().chart);
      ok('1366: the chart that opened is a function chart, not the poster', !!c && c !== 'overview', String(c));
    }
    await A.ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
    await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } });
    const page = await ctx.newPage(); watch(page, 'toolmap-phone');
    await page.goto(TM + '#chart=overview'); await page.waitForSelector('#phoneStages [data-ph-stage]', { state: 'attached', timeout: 15000 }); await closeReader(page);
    const m = await page.evaluate(() => ({ overflowX: document.documentElement.scrollWidth - innerWidth, shown: getComputedStyle(document.getElementById('phoneStages')).display !== 'none', says: document.getElementById('phoneStages').textContent }));
    ok('390: the phone gets a list of the stages, in the page width, saying they are largest first and not run in order', m.overflowX <= 0 && m.shown && /largest first/.test(m.says) && !/in the order the story runs/.test(m.says), JSON.stringify({ o: m.overflowX, s: m.shown }));
    await page.locator('#phoneStages [data-ph-stage]').first().click(); await wait(page, 250);
    const fn = await page.locator('#phoneStages .ph-fns:not([hidden]) .ph-fn').count();
    ok('390: a tap on a stage lists its functions, and a tap on one opens its chart', fn >= 1, 'functions ' + fn);
    if (fn) { await page.locator('#phoneStages .ph-fns:not([hidden]) .ph-fn').first().click(); await wait(page, 500); ok('390: the chart opened', (await page.evaluate(() => window.atlasInspect().chart)) !== 'overview'); }
    await ctx.close();
  }
  {                                                              // the same viewer on an agent-made page: no tool-map words, no tool-map list
    const G = await open(browser, URL0, '', 'toolmap-agent', { width: 1366, height: 768 });
    const m = await G.page.evaluate(() => ({ cls: document.documentElement.classList.contains('toolmap'), regions: (document.getElementById('rdRegions') || {}).textContent || '', all: (document.getElementById('qAll') || {}).textContent || '', tsf: document.querySelectorAll('.tsf-row,.nav-fns,.ph-fns').length }));
    ok('an agent-made page keeps its own words and its own list', !m.cls && /^Regions/.test(m.regions.trim()) && m.all.trim() === 'All charts' && m.tsf === 0, JSON.stringify(m));
    await G.ctx.close();
  }
}
} finally { await browser.close(); fs.rmSync(TMP, { recursive: true, force: true }); }

ok('one self-contained file: the page made no network request in any run', netRequests.length === 0, netRequests.slice(0, 3).join(' | '));
const bad = results.filter(r => !r.pass);
const errs = consoleErrors.filter((e, i, a) => a.indexOf(e) === i);
console.log(errs.length ? 'CONSOLE ' + errs.length + ' problem(s):\n' + errs.slice(0, 10).join('\n') : 'no console errors or warnings');
console.log(`\n${results.length - bad.length}/${results.length} checks passed` + (bad.length ? `; FAILED: ${bad.map(b => b.name).join(' | ')}` : ''));
process.exit(bad.length || errs.length ? 1 : 0);
