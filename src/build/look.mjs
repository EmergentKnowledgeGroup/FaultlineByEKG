// look(dir, {page, ids, stage, ev, width, height}) -> {ok, files:[...], notes:[...], reason?}
// Renders what a person would see, to PNG files an agent can open.
//   default   each chart's stand-alone SVG, drawn from its SAVED LAYOUT (layout/<id>.json): no build, no dist/ page needed. Charts with no layout
//             are listed in `notes`, not guessed at. Written to dist/png/<id>.png.
//   page:true the real atlas page at 1920x1080, one shot per chart (dist/shots/<id>.png), optionally with the evidence layer on. Needs a built page.
//   stage     only that stage's chart parts; when the whole model is refused (a problem in another stage's fragment) it uses only that stage's
//             fragments plus 00-*, the same way  place --stage  does.
// Headless, one browser, closed in finally. Without Chromium or playwright-core it says so and returns ok:false; nothing else depends on it.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findChromium, chartCss } from '../engine/preview.mjs';
import { renderSVG } from '../engine/render.mjs';
import { loadModelReport } from '../model/index.mjs';
import { chartsFromModel } from './charts.mjs';
import { loadLayouts } from './layout.mjs';
import { modelForStage } from './stagescope.mjs';

// the charts to show: {charts, model, note} or {reason}
function pick(dir, o) {
  const m = o.stage ? modelForStage(dir, o.stage) : (() => { const r = loadModelReport(dir); return { model: r.model, refusals: r.refusals, scoped: false, note: '' }; })();
  if (m.refusals.length) return { reason: `the model is refused (${m.refusals.length}): ${m.refusals.slice(0, 2).map((r) => r.msg).join(' ')}${o.stage ? '' : ' Fix: look at one stage with  faultline look --stage <id>  (it needs only that stage\'s fragments).'}` };
  const all = chartsFromModel(m.model);
  const bad = (o.ids || []).filter((id) => !all.some((c) => c.id === id));
  if (bad.length) return { reason: `no chart named ${bad.join(', ')}. Charts: ${all.slice(0, 12).map((c) => c.id).join(', ')}${all.length > 12 ? ', ...' : ''}.` };
  const charts = all.filter((c) => (!o.ids || o.ids.includes(c.id)) && (!o.stage || c.stage === o.stage));
  if (!charts.length) return { reason: o.stage ? `stage ${o.stage} has no chart (is the id right? faultline plan lists stages)` : 'the model has no charts' };
  return { charts, model: m.model, note: m.note };
}

export async function look(dir, o = {}) {
  const dist = path.join(dir, 'dist'), html = path.join(dist, 'atlas.html');
  if (o.page && !fs.existsSync(html)) return { ok: false, files: [], reason: `${html} does not exist. Fix: run  faultline build  first (faultline look without --page needs no build).` };
  const chrome = findChromium();
  if (!chrome) return { ok: false, files: [], reason: 'no Chromium found (set CHROME_PATH, or install playwright\'s chromium, Chrome or Edge)' };
  let pw;
  try { pw = await import('playwright-core'); } catch { return { ok: false, files: [], reason: 'playwright-core is not installed (npm install in the faultline folder)' }; }
  const p = pick(dir, o);
  if (p.reason) return { ok: false, files: [], reason: p.reason };
  const notes = p.note ? [p.note] : [];
  const files = [];
  let browser;
  try {
    if (o.page) {
      const built = fs.existsSync(path.join(dist, 'svg')) ? fs.readdirSync(path.join(dist, 'svg')).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)) : [];
      const ids = p.charts.map((c) => c.id).filter((id) => built.includes(id));
      if (!ids.length) return { ok: false, files: [], reason: `the built page has none of: ${p.charts.map((c) => c.id).join(', ')}. Fix: faultline build.`, notes };
      browser = await pw.chromium.launch({ executablePath: chrome, headless: true, args: ['--disable-gpu'] });      // software raster: the page is looked at the same way on any machine, whatever its GPU does
      const outDir = path.join(dist, 'shots'), W = o.width || 1920, H = o.height || 1080;
      fs.mkdirSync(outDir, { recursive: true });
      const ctx = await browser.newContext({ viewport: { width: W, height: H } });
      await ctx.addInitScript(() => { try { localStorage.setItem('faultline-atlas-onboarded', '1'); } catch (e) { /* private mode */ } });   // the first-visit card would sit over the map
      const pg = await ctx.newPage();
      const errors = [];
      pg.on('pageerror', (e) => errors.push(String(e.message || e).split('\n')[0]));
      pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().split('\n')[0]); });
      for (const id of ids) {
        await pg.goto(pathToFileURL(html).href + '#chart=' + id + (o.ev ? '&ev=1' : ''));
        await pg.reload();
        await pg.waitForSelector('#canvas svg', { timeout: 15000 });
        await pg.waitForTimeout(700);
        const f = path.join(outDir, id + (o.ev ? '.ev' : '') + '.png');
        await pg.screenshot({ path: f }); files.push(f);
      }
      await ctx.close();
      return { ok: true, files, errors, notes };
    }
    const L = await loadLayouts(dir, p.model, p.charts);
    const have = p.charts.filter((c) => L.geoms[c.id]), lack = p.charts.filter((c) => !L.geoms[c.id]);
    if (lack.length) notes.push(`no saved layout for ${lack.length} chart(s), not shown: ${lack.slice(0, 8).map((c) => c.id).join(', ')}${lack.length > 8 ? ', ...' : ''}. Fix: faultline place${o.stage ? ' --stage ' + o.stage : ' ' + lack[0].id}`);
    if (!have.length) return { ok: false, files: [], reason: notes.pop(), notes };
    browser = await pw.chromium.launch({ executablePath: chrome, headless: true });
    const outDir = path.join(dist, 'png');
    fs.mkdirSync(outDir, { recursive: true });
    const css = chartCss();
    for (const c of have) {
      const geom = L.geoms[c.id], big = geom.edges.length > 600, svg = renderSVG(geom, { portals: [], ...(big ? { hops: false, handles: false } : {}) }).replace(/^<\?xml[^>]*\?>\s*/, '');
      const m = /<svg[^>]*?\swidth="([\d.]+)"[^>]*?\sheight="([\d.]+)"/.exec(svg) || /<svg[^>]*?\sheight="([\d.]+)"[^>]*?\swidth="([\d.]+)"/.exec(svg);
      const w = m ? +m[1] : geom.width || 1600, h = m ? +m[2] : geom.height || 900, vw = o.width || 1920, vh = Math.max(500, Math.min(2600, Math.round(vw * h / w)));
      const pg = await browser.newPage({ viewport: { width: vw, height: vh } });
      await pg.setContent(`<!doctype html><meta charset=utf-8><style>${css}html,body{margin:0;background:#0d1a21;height:100%}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
      const f = path.join(outDir, c.id + '.png');
      await pg.screenshot({ path: f }); files.push(f);
      await pg.close();
    }
    return { ok: true, files, notes };
  } catch (e) {
    return { ok: false, files, reason: 'screenshot failed: ' + String(e.message || e).split('\n')[0], notes };
  } finally {
    if (browser) await browser.close();
  }
}
