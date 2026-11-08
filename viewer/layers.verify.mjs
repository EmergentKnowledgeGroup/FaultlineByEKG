// Checks for the two viewer layers in headless Chromium: zoom-dependent text (viewer/zoomtext.js) and the evidence layer (viewer/evidence.js + evidence.css).
//   node viewer/layers.verify.mjs [--shots <dir>] [--only text|evidence|perf] [--chrome <path>]
//   (on a shared machine, run it so that only one browser is open at a time)
// Pages: the parcel-desk fixture and the large made-up map (viewer/fake-map.mjs), each with seeded fake evidence (viewer/fake-evidence.mjs), and the fixture without any.
// Exits 0 with a SKIP line when no Chromium is found (the page itself needs none).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeAtlasData } from './fixture.mjs';
import { makeBigData } from './fixture-big.mjs';
import { makeFakeData } from './fake-map.mjs';
import { addFakeEvidence } from './fake-evidence.mjs';
import { buildPage } from './fixture-page.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const ONLY = flag('only', ''), SHOTS = flag('shots', '');
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

function findChrome() {
  const c = [flag('chrome', ''), process.env.CHROME_PATH];
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright'), path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')];
  for (const d of caches) {
    if (!d) continue;
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
if (!CHROME || !chromium) { console.log('SKIP layers.verify: ' + (!chromium ? 'playwright-core is not installed' : 'no Chromium found (set CHROME_PATH)') + '. The page needs no browser; only this check does.'); process.exit(0); }

// ---- pages: the test builder in fixture-page.mjs does not know evidence.css (the product assembler does), so it is added after the other styles -----------
const evCss = fs.readFileSync(path.join(here, 'evidence.css'), 'utf8').replace(/\r\n/g, '\n');
const withCss = html => { const i = html.lastIndexOf('</style>'); return html.slice(0, i) + '\n' + evCss + '\n' + html.slice(i); };
function pageWithout(data, skip) {                                   // the same page with some of the viewer's includes left out (for the cost comparison)
  const read = f => fs.readFileSync(path.join(here, f), 'utf8').replace(/\r\n/g, '\n');
  const css = ['svg.css', 'viewer.css', 'flow.css'].map(read).join('\n');
  const js = read('viewer.js').replace(/\/\*__INCLUDE:([\w.-]+)__\*\//g, (m, n) => skip.includes(n) || n === 'guides.js' || !fs.existsSync(path.join(here, n)) ? '' : read(n));
  const BS = String.fromCharCode(92), json = JSON.stringify(data).split('<').join(BS + 'u003c');
  return read('shell.html').replace('/*__CSS__*/', () => css).replace('/*__DATA__*/', () => json)
    .replace('/*__RENDER__*/', () => read('../src/engine/render.mjs').replace(/^export\s+(default\s+)?/gm, '')).replace('/*__JS__*/', () => js);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-layers-'));
const mk = (name, data, builder = buildPage) => { const f = path.join(TMP, name + '.html'); fs.writeFileSync(f, withCss(builder(data))); return pathToFileURL(f).href; };
const fxData = addFakeEvidence(await makeAtlasData(), { seed: 3 }), fakeData = addFakeEvidence(makeFakeData({}), { seed: 3 }), bigData = addFakeEvidence(makeBigData(), { seed: 5 });
const plainData = await makeAtlasData();
const URL_FX = mk('fx', fxData), URL_FAKE = mk('fake', fakeData), URL_BIG = mk('big', bigData), URL_PLAIN = mk('plain', plainData);
const URL_FAKE_LEAN = mk('fake-lean', makeFakeData({}), d => pageWithout(d, ['zoomtext.js', 'evidence.js']));
const URL_FAKE_ZT = mk('fake-zt', makeFakeData({}), d => pageWithout(d, ['evidence.js']));

const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass, info }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + String(info).slice(0, 220) : '')); };
const consoleErrors = [], netRequests = [];
const watch = (page, label) => {
  page.on('request', r => { if (!/^(file|data|blob|about):/.test(r.url())) netRequests.push(label + ' ' + r.url()); });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(label + ' console.' + m.type() + ': ' + m.text()); });
  page.on('pageerror', e => consoleErrors.push(label + ' pageerror: ' + e.message));
};
const browser = await chromium.launch({ executablePath: CHROME, args: ['--disable-gpu'] });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const wait = (page, ms = 250) => page.waitForTimeout(ms);
async function open(url, hash, label, { theme = 'dark', vp = { width: 1920, height: 1080 }, opts = {} } = {}) {
  const ctx = await browser.newContext({ viewport: vp, ...opts });
  await ctx.addInitScript(t => { try { localStorage.setItem('faultline-atlas-theme', t); localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* ignore */ } }, theme);
  const page = await ctx.newPage(); watch(page, label);
  await page.goto(url + (hash || '')); await page.waitForSelector('#atlas', { timeout: 15000 }); await wait(page, 350);
  return { ctx, page };
}
const want = n => !ONLY || ONLY === n;

// ---- in-page helpers (run inside the browser) ------------------------------------------------------------------------------------------------
const PAGE_FNS = {
  audit() {            // every visible svg text with its size on screen
    const svg = document.getElementById('atlas'), out = { shown: 0, min: {}, bad: [] };
    svg.querySelectorAll('text').forEach(t => {
      for (let p = t; p && p !== svg.parentNode; p = p.parentNode) { const c = getComputedStyle(p); if (c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) === 0) return; }
      const m = t.getScreenCTM(); if (!m) return;
      const px = parseFloat(getComputedStyle(t).fontSize) * Math.hypot(m.a, m.b), cls = (t.getAttribute('class') || 'text').split(' ')[0];
      out.shown++; out.min[cls] = Math.min(out.min[cls] ?? 1e9, +px.toFixed(2)); if (px < 10.99) out.bad.push(cls + '@' + px.toFixed(2));
    });
    out.bad = [...new Set(out.bad)]; out.scale = +window.atlasInspect().scale.toFixed(3); out.cls = svg.getAttribute('class'); return out;
  }
};
const audit = page => page.evaluate(PAGE_FNS.audit);
const rgb = s => { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s); return m ? [+m[1], +m[2], +m[3]] : null; };
const hex = s => { s = String(s).trim().replace('#', ''); if (s.length === 3) s = s.replace(/./g, '$&$&'); return /^[0-9a-f]{6}$/i.test(s) ? [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) : null; };
const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hue = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (!d) return -1; const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return (h * 60 + 360) % 360; };
const isGreen = c => { const h = hue(c); return h >= 75 && h <= 170 && Math.max(...c) - Math.min(...c) > 40; };

try {
/* ============================================================================ A. zoom-dependent text */
if (want('text')) {
  const ZOOMS = [0.08, 0.12, 0.18, 0.25, 0.3, 0.4, 0.55, 0.62, 0.7, 0.75, 0.85, 1, 1.5, 2.5, 4];
  for (const [label, url, hash] of [['fixture whole', URL_FX, '#chart=whole'], ['fixture stage', URL_FX, '#chart=stage_queue'], ['large map', URL_FAKE, '#chart=whole'], ['big grid', URL_BIG, '#chart=big']]) for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open(url, hash, label, { theme }), bad = [], seen = [];
    let r = await audit(page); seen.push(r.scale); if (r.bad.length) bad.push('fit ' + r.bad.join());
    for (const z of ZOOMS) { await page.evaluate(s => window.atlasZoomTo(s), z); await wait(page, 60); r = await audit(page); if (r.bad.length) bad.push(z + ' ' + r.bad.join()); }
    ok(`text: ${label} ${theme}: no visible text under 11 screen px at fit and ${ZOOMS.length} zooms`, !bad.length, bad.join(' | ') || `fit scale ${seen[0]}`);
    await ctx.close();
  }
  { // the look at the three tiers on the large map, and what each tier shows
    const { ctx, page } = await open(URL_FAKE, '#chart=whole', 'tiers');
    const at = async z => { await page.evaluate(s => window.atlasZoomTo(s), z); await wait(page, 120); return page.evaluate(() => { const s = document.getElementById('atlas'), c = s.classList, n = (sel, keep) => [...s.querySelectorAll(sel)].filter(e => { if (keep && !keep(e)) return false; for (let p = e; p && p !== s.parentNode; p = p.parentNode) if (getComputedStyle(p).display === 'none') return false; return true; }).length; return { calm: c.contains('zt-calm'), tiny: c.contains('zt-tiny'), nodeText: n('.node-text'), numbers: n('.stp-no', e => /[0-9]/.test(e.textContent)) + n('.htitle,.zt-num'), pills: n('g.stpill'), halos: n('g.cluster') + n('.halo.on'), boxes: n('.node-box'), clFar: n('.cl-far') }; }); };
    const far = await at(0.1), mid = await at(0.4), near = await at(1.1);
    ok('text: far zoom hides every box title and keeps boxes, halos and stage numbers', far.calm && far.tiny && far.nodeText === 0 && far.boxes > 300 && far.halos >= 10 && far.numbers >= 12 && far.clFar === 0, JSON.stringify(far));
    ok('text: mid zoom is calm shapes with stage numbers, no box titles', mid.calm && !mid.tiny && mid.nodeText === 0 && mid.numbers >= 6 && mid.clFar === 0, JSON.stringify(mid));
    ok('text: near zoom brings the full text back', !near.calm && near.nodeText > 20, JSON.stringify(near));
    const sz = await page.evaluate(() => { const s = document.getElementById('atlas'); return { whole: s.classList.contains('zt-whole') }; });
    ok('text: the whole map never shows large names over its boxes (far captions off)', sz.whole);
    await page.evaluate(s => window.atlasZoomTo(s), 0.65); await wait(page, 150);
    const chip = await page.evaluate(() => { const t = [...document.querySelectorAll('#atlas .chip-text')].filter(e => { for (let p = e; p; p = p.parentNode) if (p.nodeType === 1 && getComputedStyle(p).display === 'none') return false; return true; }); const m = t[0] && t[0].getScreenCTM(); return { n: t.length, px: m ? parseFloat(getComputedStyle(t[0]).fontSize) * Math.hypot(m.a, m.b) : 0 }; });
    ok('text: a handle chip shows only where its box shows its name, and then keeps its text at 11 px or more (none on a box with no name)', chip.n === 0 || chip.px >= 11, JSON.stringify(chip));
    await page.evaluate(s => window.atlasZoomTo(s), 0.1); await wait(page, 150); await shot(page, 'text_far_dark');
    await page.evaluate(s => window.atlasZoomTo(s), 0.4); await wait(page, 150); await shot(page, 'text_mid_dark');
    await ctx.close();
  }
  { // the page as a person meets it: fit, both themes, 1366x768 too
    for (const [theme, vp] of [['light', { width: 1920, height: 1080 }], ['dark', { width: 1366, height: 768 }]]) {
      const { ctx, page } = await open(URL_FAKE, '#chart=whole', 'fit' + theme, { theme, vp }); const r = await audit(page);
      ok(`text: large map at fit, ${theme} ${vp.width}x${vp.height}: nothing under 11 px`, !r.bad.length, `scale ${r.scale} ${r.bad.join()}`); await shot(page, `text_fit_${theme}_${vp.width}`); await ctx.close();
    }
  }
}

/* ============================================================================ B. the cost of the text layer, on the 340-box map */
if (want('perf')) {
  const run = async url => {
    const { ctx, page } = await open(url, '#chart=whole', 'perf');
    const t = await page.evaluate(async () => {
      const times = [];
      for (let i = 0; i < 90; i++) { const s = 0.1 * Math.pow(15, (i % 30) / 29); const t0 = performance.now(); window.atlasZoomTo(s); document.getElementById('atlas').getBoundingClientRect(); times.push(performance.now() - t0); }
      times.sort((a, b) => a - b); return { med: times[45], p95: times[85], max: times[89] };
    });
    await ctx.close(); return t;
  };
  const lean = await run(URL_FAKE_LEAN), withZt = await run(URL_FAKE_ZT);
  ok('perf: the text layer adds under 2 ms to a zoom step on the 400-box map', withZt.med - lean.med < 2 && withZt.p95 - lean.p95 < 6, `median ${lean.med.toFixed(2)} -> ${withZt.med.toFixed(2)} ms, p95 ${lean.p95.toFixed(2)} -> ${withZt.p95.toFixed(2)} ms`);
}

/* ============================================================================ C. the evidence layer */
if (want('evidence')) {
  { // off by default: the page is simply the atlas
    const { ctx, page } = await open(URL_FX, '#chart=whole', 'ev-off');
    const m = await page.evaluate(() => { const b = document.getElementById('rdEvidence'), s = document.getElementById('atlas'); return { btn: !!b, hidden: b && b.hidden, pressed: b && b.getAttribute('aria-pressed'), text: b && b.textContent.trim(), marks: document.querySelectorAll('.ev-m,.ev-band,.ev-b,.ev-wg,[data-ev]').length, cls: s.getAttribute('class'), dock: !document.getElementById('dockPanel').hidden, bar: [...document.querySelectorAll('#regionDock .rd-bar button')].filter(x => !x.hidden).map(x => x.textContent.trim().replace(/\s+\d+$/, '')) }; });
    ok('evidence: the switch sits in the map toolbar after Regions, off by default (the whole map has no Halos or Labels buttons: its stage districts and pills are always drawn)', m.btn && !m.hidden && m.pressed === 'false' && /Evidence/.test(m.text) && m.bar.includes('Regions') && !m.bar.includes('Halos') && !m.bar.some(x => /^Labels/.test(x)) && m.bar.indexOf('Evidence') > m.bar.indexOf('Regions'), JSON.stringify(m.bar));
    { // Halos and Labels live inside Regions on a chart that has several regions: they show once Regions is open, sit before Evidence, and each changes the drawing (compared by pixels)
      const c2 = await open(URL_FX, '#chart=stage_queue', 'ev-halos'), p2 = c2.page;
      await p2.click('#rdRegions'); await wait(p2, 350);
      const bar = await p2.evaluate(() => [...document.querySelectorAll('#regionDock .rd-bar button')].filter(x => !x.hidden && getComputedStyle(x).display !== 'none').map(x => x.textContent.trim().replace(/s+[0-9]+$/, '')));
      ok('evidence: Halos and Labels are in the toolbar once Regions is open, before the Evidence switch', bar.includes('Halos') && bar.some(x => /^Labels/.test(x)) && bar.indexOf('Evidence') > bar.indexOf('Halos'), JSON.stringify(bar));
      const idle = () => p2.evaluate(() => ({ h: document.getElementById('rdHalos').getAttribute('aria-disabled'), l: document.getElementById('rdLabels').getAttribute('aria-disabled'), note: (() => { const n = document.getElementById('rpZoom'); return n && !n.hidden ? n.textContent : ''; })(), z: window.atlasInspect().scale }));
      const atFit = await idle();
      ok('evidence: at a zoom where Halos and Labels would draw nothing, both buttons are marked disabled and the Regions list says why', atFit.h === 'true' && atFit.l === 'true' && /zoomed out/.test(atFit.note), JSON.stringify(atFit));
      await p2.evaluate(() => window.atlasZoomTo(0.1)); await wait(p2, 350);
      const atFar = await idle();
      ok('evidence: zoomed out, both buttons are live and the note is gone', atFar.h === null && atFar.l === null && !atFar.note, JSON.stringify(atFar));
      const clip = await p2.evaluate(() => { const r = document.getElementById('canvasWrap').getBoundingClientRect(); return { x: r.left + 340, y: r.top, width: r.width - 340, height: r.height }; });
      const snap = async () => { await wait(p2, 400); return p2.screenshot({ clip }); };
      const a = await snap(); await p2.click('#rdHalos'); const b = await snap(); await p2.click('#rdHalos');
      ok('evidence: the Halos button changes the drawing when zoomed out (the picture is not the same with it off)', !a.equals(b));
      const c = await snap(); await p2.click('#rdLabels'); const d = await snap(); await p2.click('#rdLabels'); await p2.click('#rdLabels');
      ok('evidence: the Labels button changes the drawing (numbers, then names, then none)', !c.equals(d));
      await c2.ctx.close();
    }
    ok('evidence: off, nothing is drawn, no class on the map, no panel', m.marks === 0 && !/ev-/.test(m.cls) && !m.dock, `marks ${m.marks} cls ${m.cls}`);
    await ctx.close();
  }
  { // a link straight to a chart shows the Evidence chip at every width (on a laptop-sized window the Regions bar sits in the toolbar, and the chip was looked for inside the dock)
    for (const [w, h] of [[1440, 900], [1920, 1080]]) {
      const { ctx, page } = await open(URL_FX, '#chart=stage_queue', 'ev-link' + w, { vp: { width: w, height: h } });
      const m = await page.evaluate(() => { const b = document.getElementById('rdEvidence'); return { shown: !!b && !b.hidden && b.getBoundingClientRect().width > 0, inBar: !!b && !!b.closest('.rd-bar') }; });
      ok('evidence: a link straight to a stage chart shows the Evidence chip at ' + w + ' wide', m.shown && m.inBar, JSON.stringify(m));
      await ctx.close();
    }
  }
  { // a chart or page with no evidence data at all: no switch, nothing different
    const { ctx, page } = await open(URL_PLAIN, '#chart=whole', 'ev-none');
    const m = await page.evaluate(() => { const b = document.getElementById('rdEvidence'); return { hidden: !b || b.hidden, ev: document.querySelectorAll('[data-ev],.ev-m').length }; });
    ok('evidence: data without any evidence shows no switch', m.hidden && m.ev === 0);
    await ctx.close();
  }
  for (const theme of ['dark', 'light']) {
    const { ctx, page } = await open(URL_FX, '#chart=whole', 'ev-' + theme, { theme });
    const before = await page.evaluate(() => document.getElementById('vp').innerHTML.length);
    await page.click('#rdEvidence'); await wait(page, 500);
    const m = await page.evaluate(() => {
      const svg = document.getElementById('atlas'), nodes = [...svg.querySelectorAll('g.node')], edges = [...svg.querySelectorAll('g.edge')], by = a => nodes.filter(n => n.getAttribute('data-ev') === a).length;
      const ringsOf = n => n.querySelectorAll('.ev-ring').length, withMark = nodes.filter(n => n.hasAttribute('data-ev'));
      const count = (n) => { const t = n.querySelector('.ev-b .ev-bt'); return t ? t.textContent : null; };
      const seenNodes = nodes.filter(n => n.getAttribute('data-ev') === 'seen'), provedNodes = nodes.filter(n => n.getAttribute('data-ev') === 'proved');
      const bands = edges.filter(e => e.querySelector('.ev-band')).map(e => ({ id: e.dataset.edge, w: parseFloat(getComputedStyle(e.querySelector('.ev-band')).strokeWidth), lv: e.getAttribute('data-ev') }));
      return { ev: window.atlasEvidence(), sus: by('sus'), seen: by('seen'), proved: by('proved'), stale: by('stale'), unmarkedWithMark: nodes.filter(n => !n.hasAttribute('data-ev') && n.querySelector('.ev-m')).length, ringless: withMark.filter(n => !ringsOf(n)).length,
        seenCounts: seenNodes.map(count), lock: provedNodes.every(n => n.querySelector('.ev-lock')), q: nodes.filter(n => n.getAttribute('data-ev') === 'sus').every(n => [...n.querySelectorAll('.ev-bt')].some(t => t.textContent === '?')),
        dashed: nodes.filter(n => n.getAttribute('data-ev') === 'sus').every(n => getComputedStyle(n.querySelector('.ev-ring')).strokeDasharray !== 'none'), double: provedNodes.every(n => n.querySelector('.ev-ring2') && getComputedStyle(n.querySelector('.ev-ring2')).display !== 'none'),
        solidSeen: seenNodes.every(n => getComputedStyle(n.querySelector('.ev-ring')).strokeDasharray === 'none'), bands, dock: !document.getElementById('dockPanel').hidden, pressed: document.getElementById('rdEvidence').getAttribute('aria-pressed') };
    });
    const nTally = m.ev.tally;
    ok(`evidence ${theme}: on, every level is drawn: suspected dashed with "?", seen solid with a count, proved double with a lock`, m.sus === nTally.suspected && m.seen === nTally.seen && m.proved === nTally.proved && m.sus > 0 && m.seen > 0 && m.proved > 0 && m.q && m.dashed && m.solidSeen && m.double && m.lock && m.seenCounts.every(c => c && /^\d/.test(c)), JSON.stringify({ sus: m.sus, seen: m.seen, proved: m.proved, tally: nTally }));
    ok(`evidence ${theme}: a stale box is marked stale, not seen`, m.stale === nTally.stale && m.stale > 0, 'stale ' + m.stale);
    ok(`evidence ${theme}: colour only where there is evidence (every unmarked box is untouched)`, m.unmarkedWithMark === 0 && m.ringless === 0);
    const w = m.bands.filter(b => b.lv === 'seen').map(b => b.w);
    ok(`evidence ${theme}: seen routes get a band under the line, wider with more traffic`, w.length > 2 && Math.max(...w) > Math.min(...w), `widths ${[...new Set(w.map(x => x.toFixed(1)))].join(',')}`);
    ok(`evidence ${theme}: turning it on opens the docked panel`, m.dock && m.ev.owns && m.pressed === 'true');
    // colours: not green, enough contrast on the map background, outline shapes differ without colour
    const cols = await page.evaluate(() => { const r = getComputedStyle(document.documentElement), s = getComputedStyle(document.getElementById('atlas')); const g = k => r.getPropertyValue(k).trim(); return { sus: g('--ev-sus'), seen: g('--ev-seen'), brk: g('--ev-brk'), stale: g('--ev-stale'), walk: g('--ev-walk'), spine: s.getPropertyValue('--spine').trim(), bg: s.getPropertyValue('--a-bg').trim() }; });
    const bg = hex(cols.bg), probs = [];
    for (const k of ['sus', 'seen', 'brk', 'walk']) { const c = hex(cols[k]); if (!c) { probs.push(k + ' unreadable ' + cols[k]); continue; } if (isGreen(c)) probs.push(k + ' is green'); if (contrast(c, bg) < 3) probs.push(k + ' contrast ' + contrast(c, bg).toFixed(2)); }
    ok(`evidence ${theme}: no evidence colour is green and each one has 3:1 contrast on the map`, !probs.length, probs.join('; ') || ['sus', 'seen', 'brk', 'walk'].map(k => k + ' ' + contrast(hex(cols[k]), bg).toFixed(1)).join(', '));
    const sp = hex(cols.spine);
    ok(`evidence ${theme}: the main-path glow is not green while the layer is on`, sp && !isGreen(sp), cols.spine);
    await shot(page, `evidence_${theme}_whole`);
    await page.click('#rdEvidence'); await wait(page, 300);
    const off = await page.evaluate(() => ({ marks: document.querySelectorAll('.ev-m,.ev-band,.ev-b,.ev-wg,[data-ev]').length, cls: document.getElementById('atlas').getAttribute('class'), dock: !document.getElementById('dockPanel').hidden, len: document.getElementById('vp').innerHTML.length, style: document.getElementById('atlas').getAttribute('style') }));
    ok(`evidence ${theme}: switching it off removes every mark and closes the panel`, off.marks === 0 && !/ev-/.test(off.cls) && !off.dock && !/--ev/.test(off.style || ''), JSON.stringify({ marks: off.marks, cls: off.cls }));
    ok(`evidence ${theme}: off again, the map markup is exactly what it was`, off.len === before, `${before} -> ${off.len}`);
    await ctx.close();
  }
  { // the docked panel: candidates (at most ten, grouped, each with its question), not drawn yet, what was checked; clicking a mark; walks
    const { ctx, page } = await open(URL_FAKE, '#chart=whole', 'ev-panel');
    await page.click('#rdEvidence'); await wait(page, 500);
    const p = await page.evaluate(() => {
      const d = document.getElementById('dockPanel'), cards = [...d.querySelectorAll('.ev-card')], groups = [...d.querySelectorAll('.ev-grp')].map(g => g.textContent), h = [...d.querySelectorAll('.ev-h')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
      return { title: d.querySelector('.hp-h').textContent, cards: cards.length, qs: cards.every(c => (c.querySelector('.ev-q') || {}).textContent.length > 12), groups, h, more: (d.querySelector('.ev-more') || {}).textContent, txt: d.innerText, wide: d.getBoundingClientRect().width };
    });
    ok('evidence panel: candidates are capped at ten, grouped, each with its question', p.cards === 10 && p.qs && p.groups.length >= 2 && /Candidates\s+14/.test(p.h[0]), `cards ${p.cards}, groups ${p.groups.length}, heading ${p.h[0]}`);
    ok('evidence panel: says how many more there are', /4 more candidates/.test(p.txt));
    ok('evidence panel: "Not drawn yet" has a count and a list', p.h.some(x => /^Not drawn yet\s+7$/.test(x)) && /fake\/legacy\.py/.test(p.txt), p.h.join(' | '));
    ok('evidence panel: says what was checked, in the labels\' own words', /what was checked/i.test(p.txt) && /not found in what was checked/.test(p.txt));
    ok('evidence panel: no banned words (bug, dead end, unbounded, does not exist)', !/\b(bug|bugs|dead end|unbounded|does not exist|no violation found)\b/i.test(p.txt), (p.txt.match(/\b(bug|dead end|unbounded|does not exist|no violation found)\b/i) || [''])[0]);
    // nothing covers nodes: with the panel open every box sits clear of it, and no mark overlaps a box title
    const cov = await page.evaluate(() => {
      const dk = document.getElementById('dockPanel').getBoundingClientRect(), nodes = [...document.querySelectorAll('#atlas g.node')];
      const hit = nodes.filter(n => { const r = n.querySelector('.node-box').getBoundingClientRect(); return r.right > dk.left && r.left < dk.right && r.bottom > dk.top && r.top < dk.bottom; }).length;
      return { hit, vp: [...document.getElementById('vp').children].map(c => c.getAttribute('class') || c.tagName) };
    });
    ok('evidence panel: at fit no box sits under the docked panel', cov.hit === 0, `boxes under the panel: ${cov.hit}`);
    await shot(page, 'evidence_panel_fake');
    // click a mark: the panel explains it
    const sel = await page.evaluate(() => {      // 100% on the first suspected box, a little left of centre so it clears the docked panel
      const g = document.querySelector('#atlas g.node[data-ev=sus]'); if (!g) return null;
      const r = window.atlasFL.chart().nb[g.dataset.node]; window.atlasZoomTo(1.0, r.x + r.w / 2 + 160, r.y + r.h / 2); return g.dataset.node;
    }); await wait(page, 250);
    ok('evidence: a suspected box is on screen at 100% to click', !!sel);
    if (sel) {
      const pos = await page.evaluate(id => { const b = document.querySelector(`#atlas g.node[data-node="${id}"] .ev-b`).getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, sel);
      await page.mouse.click(pos.x, pos.y); await wait(page, 400);
      const d = await page.evaluate(() => { const dk = document.getElementById('dockPanel'); return { open: !dk.hidden, ev: window.atlasEvidence(), heads: [...dk.querySelectorAll('.ev-d-h')].map(h => h.textContent), q: dk.querySelector('.ev-d-t') && dk.querySelector('.ev-d-t').textContent, pinned: window.atlasInspect().pinned, txt: dk.innerText }; });
      ok('evidence: clicking a mark opens the docked panel with why, evidence, false alarm and next step', d.open && d.ev.view === 'detail' && ['Why it is marked', 'Evidence', 'What would make this a false alarm', 'Next step to strengthen it'].every(h => d.heads.some(x => x.toLowerCase() === h.toLowerCase())), d.heads.join(' | '));
      ok('evidence: the mark click also pins the box (same focus as any click)', d.pinned && d.pinned.t === 'node' && d.pinned.id === sel, JSON.stringify(d.pinned));
      await shot(page, 'evidence_mark_detail');
      await page.click('#dockPanel .ev-back'); await wait(page, 250);
      ok('evidence: "All evidence" goes back to the list', (await page.evaluate(() => window.atlasEvidence().view)) === 'overview');
    }
    // a walk lit across the map
    await page.keyboard.press('Escape'); await wait(page, 150);
    if (!(await page.evaluate(() => !document.getElementById('dockPanel').hidden))) { await page.click('#rdEvidence'); await page.click('#rdEvidence'); await wait(page, 400); }
    await page.evaluate(() => window.atlasZoomTo(0.16)); await wait(page, 200);
    const wk = await page.evaluate(() => { const b = document.querySelector('#dockPanel [data-ev-walk]:not([disabled])'); return b ? b.dataset.evWalk : null; });
    ok('evidence panel: walks are listed', !!wk);
    if (wk) {
      await page.click(`#dockPanel [data-ev-walk="${wk}"]`); await wait(page, 400);
      const w = await page.evaluate(() => { const svg = document.getElementById('atlas'), vp = document.getElementById('vp'), kids = [...vp.children], g = kids.findIndex(c => c.classList.contains('ev-wg')), nd = kids.findIndex(c => c.classList.contains('nodes'));
        const lit = [...svg.querySelectorAll('g.edge.ev-w')].length, paths = svg.querySelectorAll('.ev-wp-l').length, nodes = [...svg.querySelectorAll('g.node.ev-w')].length, dim = getComputedStyle(svg.querySelector('g.node:not(.ev-w)')).opacity;
        return { ev: window.atlasEvidence(), lit, paths, nodes, below: g >= 0 && g < nd, dim, cls: svg.classList.contains('ev-walking') }; });
      ok('evidence: selecting a walk lights its path (routes and boxes) and steps the rest back', w.ev.walk === wk && w.cls && w.nodes >= 2 && w.paths >= 1 && w.paths === w.lit && parseFloat(w.dim) < 0.5, JSON.stringify(w));
      ok('evidence: the lit path sits under the boxes, never over them', w.below);
      await shot(page, 'evidence_walk_lit');
      await page.keyboard.press('Escape'); await wait(page, 250);
      ok('evidence: Esc clears the lit walk', (await page.evaluate(() => ({ w: window.atlasEvidence().walk, n: document.querySelectorAll('.ev-wp-l').length }))).n === 0);
    }
    await ctx.close();
  }
  { // marks never cover a box title (checked at 100% on the large map and the fixture)
    for (const [label, url, hash] of [['large map', URL_FAKE, '#chart=whole'], ['fixture', URL_FX, '#chart=stage_queue']]) {
      const { ctx, page } = await open(url, hash, 'ev-cover');
      await page.click('#rdEvidence'); await wait(page, 400); await page.click('#dockPanel .hp-close').catch(() => {}); await wait(page, 200);
      let bad = 0, checked = 0;
      for (const z of [1, 1.6]) {
        await page.evaluate(s => window.atlasZoomTo(s), z); await wait(page, 120);
        const r = await page.evaluate(() => { let bad = 0, n = 0; document.querySelectorAll('#atlas g.node[data-ev]').forEach(g => { const rs = [...g.querySelectorAll('.node-text')].map(t => t.getBoundingClientRect()); [...g.querySelectorAll('.ev-b .ev-bd, .ev-ring, .ev-ring2')].forEach(m => { if (m.classList.contains('ev-ring') || m.classList.contains('ev-ring2')) return; const b = m.getBoundingClientRect(); n++; if (rs.some(t => b.right > t.left && b.left < t.right && b.bottom > t.top && b.top < t.bottom)) bad++; }); }); return { bad, n }; });
        bad += r.bad; checked += r.n;
      }
      ok(`evidence: no badge covers a box title (${label})`, bad === 0 && checked > 0, `checked ${checked}, overlaps ${bad}`);
      await ctx.close();
    }
  }
  { // a link can open the page with the layer on; forced colours still show the outline shapes
    const { ctx, page } = await open(URL_FX, '#chart=whole&ev=1', 'ev-link');
    ok('evidence: #ev=1 in a link opens the page with the layer on', await page.evaluate(() => window.atlasEvidence().on && !document.getElementById('dockPanel').hidden));
    await ctx.close();
    const fc = await open(URL_FX, '#chart=whole&ev=1', 'ev-forced', { opts: { forcedColors: 'active' } });
    const f = await fc.page.evaluate(() => { const s = [...document.querySelectorAll('#atlas g.node[data-ev]')].map(n => { const r = n.querySelector('.ev-ring'); const c = getComputedStyle(r); return c.stroke + '|' + c.strokeDasharray; }); return { colours: [...new Set(s.map(x => x.split('|')[0]))].length, dashes: [...new Set(s.map(x => x.split('|')[1]))].length, n: s.length }; });
    ok('evidence: in forced-colours mode the levels still differ by outline shape', f.n > 0 && f.dashes >= 2, JSON.stringify(f));
    await shot(fc.page, 'evidence_forced_colors'); await fc.ctx.close();
  }
  { // moving between charts keeps the layer on and redraws it; a phone-width window does not break
    const { ctx, page } = await open(URL_FX, '#chart=whole', 'ev-nav');
    await page.click('#rdEvidence'); await wait(page, 400);
    await page.evaluate(() => window.atlasOpen('stage_queue')); await wait(page, 500);
    const m = await page.evaluate(() => ({ ev: window.atlasEvidence(), marks: document.querySelectorAll('#atlas [data-ev]').length, panel: !document.getElementById('dockPanel').hidden, chart: window.atlasInspect().chart, cards: document.querySelectorAll('#dockPanel .ev-card').length }));
    ok('evidence: moving to another chart keeps the switch on and redraws its marks and list', m.chart === 'stage_queue' && m.ev.on && m.marks > 0 && m.panel && m.ev.boxes + m.ev.routes > 0, JSON.stringify({ marks: m.marks, cards: m.cards }));
    await ctx.close();
    const ph = await open(URL_FX, '#chart=stage_queue', 'ev-phone', { vp: { width: 390, height: 844 } });
    await ph.page.evaluate(() => { const b = document.getElementById('rdEvidence'); b && b.click(); }); await wait(ph.page, 400);
    const o = await ph.page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth, marks: document.querySelectorAll('#atlas [data-ev]').length }));
    ok('evidence: at phone width the page does not overflow sideways', o.overflow <= 0, JSON.stringify(o));
    await shot(ph.page, 'evidence_phone'); await ph.ctx.close();
  }
  { // perf: the layer on the 340-box map and the 224-box grid
    for (const [label, url, hash] of [['large map', URL_FAKE, '#chart=whole'], ['big grid', URL_BIG, '#chart=big']]) {
      const { ctx, page } = await open(url, hash, 'ev-perf');
      const t = await page.evaluate(async () => { const b = document.getElementById('rdEvidence'), t0 = performance.now(); b.click(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); const on = performance.now() - t0, zs = []; for (let i = 0; i < 60; i++) { const a = performance.now(); window.atlasZoomTo(0.1 * Math.pow(15, (i % 30) / 29)); document.getElementById('atlas').getBoundingClientRect(); zs.push(performance.now() - a); } zs.sort((x, y) => x - y); return { on, med: zs[30], p95: zs[57] }; });
      ok(`evidence perf: ${label}: switching on takes under 400 ms and a zoom step stays under 12 ms`, t.on < 400 && t.med < 12, `on ${t.on.toFixed(0)} ms, zoom median ${t.med.toFixed(1)} ms, p95 ${t.p95.toFixed(1)} ms`);
      await ctx.close();
    }
  }
}
} finally { await browser.close(); }

ok('no console errors or warnings in any run', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
ok('no network request in any run', netRequests.length === 0, netRequests.slice(0, 3).join(' | '));
const fail = results.filter(r => !r.pass);
console.log(`\n${results.length - fail.length}/${results.length} checks passed`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail.length ? 1 : 0);
