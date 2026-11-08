// assemble(atlasData, outDir, {excerpts=false, root, viewerDir}) -> {html, svgs, bytes}
// Writes <outDir>/atlas.html (ONE self-contained page: data, renderer, scripts and styles inlined, no network) and <outDir>/svg/<chartId>.svg
// (stand-alone themed SVG per chart). Source excerpts are OFF by default: with {excerpts:true} each source ref carries a few lines of the file
// it points at (read from `root`, only files inside it: a ref path that is absolute, climbs out with '..' or leads out through a link gets none),
// which the inspector shows; the page then contains source text, so share it with the same care as the code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderSVG } from '../engine/render.mjs';
import { stripJs, stripCss } from './strip.mjs';
import { RootedSource } from '../story/source.mjs';
import { normPath } from '../model/refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const VIEWER_DIR = path.join(here, '..', '..', 'viewer');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const esc = (s) => String(s).replace(/[&<>"]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
// CSS order matters: the chart skin, the page, the flow bar and regions, the guides, then the evidence layer
const CSS = ['svg.css', 'viewer.css', 'flow.css', 'guides.css', 'evidence.css', 'whole.css', 'walk.css', 'breaks.css', 'look.css', 'frame.css', 'phone.css'];

// the engine renderer as a classic script: drop `export`, refuse `import`
export function classic(src) {
  if (/^\s*import\s/m.test(src)) throw new Error('render module must not import anything');
  return src.replace(/^export\s+(default\s+)?/gm, '');
}

// Stripping must never change what a script is. If the original compiles and the stripped one does not, the build stops rather than ship either guess.
function checkStripped(name, before, after) {
  try { new vm.Script(before); } catch { return; }                                // a script that never compiled as a plain script is not ours to judge here
  try { new vm.Script(after); } catch (e) { throw new Error(`removing comments broke the ${name} script: ${String(e.message).split('\n')[0]}`); }
}

export function addExcerpts(data, root, { lines = 12, width = 160 } = {}) {
  const src = new RootedSource(root);                                            // the model's ref paths are not ours: only a plain file inside the root is read, anything else gets no excerpt
  let n = 0;
  for (const c of Object.values(data.charts)) for (const node of Object.values(c.nodes)) for (const r of node.refs || []) {
    if (r.excerpt || !r.path || !r.line) continue;
    const f = src.lines(normPath(r.path)); if (!f) continue;                     // normPath: a ref may say .\a.py or ./a.py, as the gates read it; '..' still shows and is refused
    r.excerpt = f.slice(Math.max(0, r.line - 1), r.line - 1 + lines).map((l) => (l.length > width ? l.slice(0, width - 1) + '…' : l)).join('\n'); n++;
  }
  return n;
}

export function assemble(data, outDir, opts = {}) {
  const vdir = opts.viewerDir || VIEWER_DIR, root = opts.root || null;
  const d = JSON.parse(JSON.stringify(data));                                     // never touch the caller's blob
  d.meta = { ...d.meta, exports: { ...(d.meta && d.meta.exports), svg: true }, excerpts: !!opts.excerpts };
  if (opts.excerpts && root) addExcerpts(d, root);
  const svgCss = read(path.join(vdir, 'svg.css'));
  const keep = !!opts.keepComments;                                               // the viewer's comments are for whoever works on it; the page leaves them out
  const css0 = CSS.map((f) => (fs.existsSync(path.join(vdir, f)) ? read(path.join(vdir, f)) : '')).join('\n');
  const js0 = read(path.join(vdir, 'viewer.js')).replace(/\/\*__INCLUDE:([\w.-]+)__\*\//g, (m, f) => (fs.existsSync(path.join(vdir, f)) ? read(path.join(vdir, f)) : ''));
  const css = keep ? css0 : stripCss(css0), js = keep ? js0 : stripJs(js0);
  if (!keep) checkStripped('viewer', js0, js);
  const LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);                    // line and paragraph separators end a script string in some engines
  const json = JSON.stringify(d).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  const render0 = classic(read(path.join(here, '..', 'engine', 'render.mjs')));
  const renderSrc = keep ? render0 : stripJs(render0);
  if (!keep) checkStripped('renderer', render0, renderSrc);
  let html = read(path.join(vdir, 'shell.html'));
  if (d.meta.title) html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${esc(d.meta.title)}</title>`);
  html = html.replace('/*__CSS__*/', () => css).replace('/*__DATA__*/', () => json)
    .replace('/*__RENDER__*/', () => renderSrc.replace(/<\/script/gi, '<\\/script')).replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
  for (const m of ['/*__CSS__*/', '/*__DATA__*/', '/*__RENDER__*/', '/*__JS__*/']) if (html.includes(m)) throw new Error('unreplaced marker ' + m);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'atlas.html'), html);

  // stand-alone SVG per chart: the chart skin is embedded so the file opens anywhere
  const svgDir = path.join(outDir, 'svg'), svgs = [];
  fs.mkdirSync(svgDir, { recursive: true });
  const css1 = svgCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
  for (const [id, c] of Object.entries(d.charts)) {
    const big = c.geom.edges.length > 400;                                        // hop-over arcs and handle chips are quadratic in the roads: a big map's export has neither (like `look`)
    const svg = renderSVG(c.geom, { portals: c.portals, ...(big ? { hops: false, handles: false } : {}) });
    const body = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.replace('>', () => `><title>${esc(c.title || id)}</title><style><![CDATA[${css1}]]></style>`);
    fs.writeFileSync(path.join(svgDir, id + '.svg'), body); svgs.push(id);
  }
  return { html: path.join(outDir, 'atlas.html'), svgs, bytes: Buffer.byteLength(html) };
}
