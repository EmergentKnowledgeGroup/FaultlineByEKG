// node src/engine/preview.mjs <graph.json> --cfg <layout.json> [--text text.json] [--render render.json] [--out dir] [--tag name]
//                             [--vw 1600 --vh 900] [--no-png]
// Lays a chart out (gridLayout needs the config's ASCII map), draws it, prints the metrics and writes <out>/<tag>.geom.json, .svg and .png
// (a screenshot at the size a real viewport would fit it). --render is a JSON of renderSVG options (chip families, kind colours ...).
// vw/vh default to metrics.FIT_VIEWPORT, the constant fitScale uses. The PNG needs playwright-core and a Chromium; without them the
// other files are still written and the output says so. Chromium is found in this order: CHROME_PATH, playwright's browser cache, then
// an installed Chrome / Chromium / Edge (findChromium below).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gridLayout } from './gridlayout.mjs';
import { renderSVG, BASE_CSS } from './render.mjs';
import { metrics, FIT_VIEWPORT } from './metrics.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const isFile = p => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };
const isDir = p => { try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; } };

// Chromium discovery: CHROME_PATH, then playwright's cache (newest revision first), then system browsers. Returns a path or null.
export function findChromium(env = process.env, platform = process.platform) {
  if (isFile(env.CHROME_PATH)) return env.CHROME_PATH;
  const home = os.homedir();
  const cache = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH
    : platform === 'win32' ? path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright')
    : platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright')
    : path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
  if (isDir(cache)) {
    const exes = {
      chromium: platform === 'win32' ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
        : platform === 'darwin' ? ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac-x64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']
        : ['chrome-linux64/chrome', 'chrome-linux/chrome'],
      shell: platform === 'win32' ? ['chrome-headless-shell-win64/chrome-headless-shell.exe']
        : platform === 'darwin' ? ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell']
        : ['chrome-headless-shell-linux64/chrome-headless-shell'],
    };
    const dirs = fs.readdirSync(cache).map(d => ({ d, m: /^(chromium|chromium_headless_shell)-(\d+)$/.exec(d) })).filter(x => x.m)
      .map(x => ({ dir: path.join(cache, x.d), rev: +x.m[2], shell: x.m[1] !== 'chromium' }))
      .sort((a, b) => a.shell - b.shell || b.rev - a.rev);
    for (const x of dirs) for (const rel of exes[x.shell ? 'shell' : 'chromium']) if (isFile(path.join(x.dir, rel))) return path.join(x.dir, rel);
  }
  const sys = [];
  if (platform === 'win32') {
    for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean)) sys.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(base, 'Chromium', 'Application', 'chrome.exe'), path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else if (platform === 'darwin') {
    for (const app of ['Google Chrome', 'Chromium', 'Microsoft Edge']) sys.push(`/Applications/${app}.app/Contents/MacOS/${app}`, path.join(home, 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
  } else {
    for (const dir of (env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin', '/snap/bin'])) for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome']) sys.push(path.join(dir, name));
  }
  return sys.find(isFile) || null;
}

// the stylesheet the page uses for the chart (viewer/svg.css) so a preview looks like the product; the built-in minimal one if it is not there
export function chartCss() {
  const p = path.join(here, '..', '..', 'viewer', 'svg.css');
  return isFile(p) ? fs.readFileSync(p, 'utf8') : BASE_CSS;
}

// screenshot an SVG string at vw x vh. Returns { ok:true } or { ok:false, reason } (no playwright-core, no Chromium, launch failure).
export async function shoot(svgString, pngPath, vw = FIT_VIEWPORT.w, vh = FIT_VIEWPORT.h, { chrome = findChromium() } = {}) {
  if (!chrome) return { ok: false, reason: 'no Chromium found (set CHROME_PATH, or install playwright\'s chromium, Chrome or Edge)' };
  let pw;
  try { pw = await import('playwright-core'); } catch { return { ok: false, reason: 'playwright-core is not installed' }; }
  let browser;
  try {
    browser = await pw.chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ viewport: { width: vw, height: vh } });
    await page.setContent(`<!doctype html><meta charset=utf-8><style>${chartCss()}html,body{margin:0;background:#0d1a21;height:100%;display:flex;align-items:center;justify-content:center}svg{display:block;width:100vw;height:100vh}</style>${svgString.replace(/ width="[\d.]+" height="[\d.]+"/, '')}`);
    await page.screenshot({ path: pngPath });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'screenshot failed: ' + (e.message || e).toString().split('\n')[0] };
  } finally {
    if (browser) await browser.close();
  }
}

// lay out + draw + measure one chart. graph may carry .text; opts: { outDir, tag, vw, vh, png, render }
export async function previewChart(graph, cfg, { outDir = null, tag = graph.id || 'chart', vw = FIT_VIEWPORT.w, vh = FIT_VIEWPORT.h, png = true, render = {} } = {}) {
  const geom = await gridLayout(graph, cfg);
  const m = metrics(geom);
  const svg = renderSVG(geom, render);
  const res = { geom, metrics: m, svg, files: [], pngSkipped: null };
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, tag);
    fs.writeFileSync(base + '.geom.json', JSON.stringify(geom));
    fs.writeFileSync(base + '.svg', svg.replace('>', `><style>${chartCss()}</style>`));
    res.files.push(base + '.geom.json', base + '.svg');
    if (png) {
      const r = await shoot(svg, base + '.png', vw, vh);
      if (r.ok) res.files.push(base + '.png'); else res.pngSkipped = r.reason;
    }
  }
  return res;
}

const same = (a, b) => { try { const x = fs.realpathSync.native(a), y = fs.realpathSync.native(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; } catch { return false; } };
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!args[0] || args[0].startsWith('--') || !flag('cfg', null)) {
    console.error('usage: preview.mjs <graph.json> --cfg <layout.json> [--text text.json] [--render render.json] [--out dir] [--tag name] [--vw 1600 --vh 900] [--no-png]\n  the layout config must have a "map" (there is no automatic placement; placeChart writes one)');
    process.exit(2);
  }
  const graph = readJson(args[0]);
  if (flag('text', null)) graph.text = readJson(flag('text'));
  const cfg = readJson(flag('cfg'));
  const r = await previewChart(graph, cfg, {
    outDir: flag('out', path.join(process.cwd(), 'preview')), tag: flag('tag', graph.id || path.basename(args[0], '.json')),
    vw: +flag('vw', FIT_VIEWPORT.w), vh: +flag('vh', FIT_VIEWPORT.h), png: !args.includes('--no-png'), render: flag('render', null) ? readJson(flag('render')) : {},
  });
  console.log(JSON.stringify(r.metrics, null, 1));
  for (const f of r.files) console.log('wrote', f);
  if (r.pngSkipped) console.log('PNG skipped: ' + r.pngSkipped);
}
