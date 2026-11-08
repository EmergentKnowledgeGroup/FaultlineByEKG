// Test page builder for the viewer: shell.html + the CSS files + the engine renderer + the data + viewer.js (with its INCLUDE lines filled in).
// This is NOT the product assembler (src/build owns that); it only lets the viewer be opened and tested on the fixture data alone.
//   import { buildPage } from './fixture-page.mjs';   const html = buildPage(data);
//   node viewer/fixture-page.mjs --out <file.html> [--big] [--guides] [--render <render.mjs>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

// classic-script form of an ES module: drop `export`, refuse `import` (the renderer is import-free by design)
export function classic(src) {
  if (/^\s*import\s/m.test(src)) throw new Error('render module must not import anything');
  return src.replace(/^export\s+(default\s+)?/gm, '');
}
// guides.js stays out of pages built here unless asked for: it may not match this data
export function buildPage(data, o = {}) {
  const render = o.render || path.join(here, '..', 'src', 'engine', 'render.mjs');
  const css = ['svg.css', 'viewer.css', 'flow.css'].concat(o.guides ? ['guides.css'] : []).concat(['whole.css', 'walk.css', 'breaks.css', 'look.css', 'frame.css', 'phone.css']).map(f => read(path.join(here, f))).join('\n');
  const skip = new Set(o.guides ? [] : ['guides.js']);
  let js = read(path.join(here, 'viewer.js'));
  js = js.replace(/\/\*__INCLUDE:([\w.-]+)__\*\//g, (m, name) => {
    if (skip.has(name)) return '';
    const f = path.join(here, name);
    return fs.existsSync(f) ? read(f) : '';
  });
  const BS = String.fromCharCode(92);   // the JSON sits inside a script element: no raw '<', no raw line or paragraph separator
  const json = JSON.stringify(data).split('<').join(BS + 'u003c').split(String.fromCharCode(0x2028)).join(BS + 'u2028').split(String.fromCharCode(0x2029)).join(BS + 'u2029');
  return read(path.join(here, 'shell.html'))
    .replace('/*__CSS__*/', () => css)
    .replace('/*__DATA__*/', () => json)
    .replace('/*__RENDER__*/', () => classic(read(render)))
    .replace('/*__JS__*/', () => js);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2), flag = n => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : null; };
  const out = flag('out');
  if (!out) { console.error('usage: node viewer/fixture-page.mjs --out <file.html> [--big] [--guides] [--render <render.mjs>]'); process.exit(2); }
  let data;
  if (args.includes('--big')) data = (await import('./fixture-big.mjs')).makeBigData();
  else data = await (await import('./fixture.mjs')).makeAtlasData();
  const html = buildPage(data, { guides: args.includes('--guides'), render: flag('render') ? path.resolve(flag('render')) : undefined });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), html);
  console.log('wrote', out, Math.round(html.length / 1024) + ' KB');
}
