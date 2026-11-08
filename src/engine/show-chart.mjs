// node src/engine/show-chart.mjs <graph.json> [--text text.json]
// Compact text dump of one chart: every node (id, kind, title, handle, plain words, why) and every edge (from -> to, type, condition, why),
// optionally with the wording overrides of a text file shown next to the originals. For reading a chart without opening the page.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function describeChart(c, text = null) {
  const out = [`# ${c.id}${c.title ? ' - ' + c.title : ''}`];
  if (c.summary) out.push(c.summary);
  out.push('', `## NODES (${c.nodes.length})`);
  for (const n of c.nodes) {
    out.push(`- ${n.id} [${n.kind ?? n.category ?? '?'}] "${n.title}"${n.handle ? ` (${n.handle})` : ''}`);
    const plain = n.plain ?? n.summary; if (plain) out.push(`    plain: ${plain}`);
    if (n.why) out.push(`    why: ${n.why}`);
    const t = text?.nodes?.[n.id]; if (t) out.push(`    NEW title: "${t.title}"${t.plain ? `  plain: ${t.plain}` : ''}${t.handle ? `  handle: ${t.handle}` : ''}`);
  }
  out.push('', `## EDGES (${c.edges.length})`);
  for (const e of c.edges) {
    out.push(`- ${e.id}  ${e.from} -> ${e.to} [${e.type ?? 'forward'}]${e.label ? ` "${e.label}"` : ''}${e.inferred ? ' (inferred)' : ''}`);
    if (e.why) out.push(`    why: ${e.why}`);
    const t = text?.edges?.[e.id]; if (t?.short) out.push(`    NEW short: "${t.short}"`);
  }
  return out.join('\n');
}

const same = (a, b) => { try { const x = fs.realpathSync.native(a), y = fs.realpathSync.native(b); return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y; } catch { return false; } };
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) {
  const a = process.argv.slice(2), flag = (n, d) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] : d; };
  if (!a[0] || a[0].startsWith('--')) { console.error('usage: show-chart.mjs <graph.json> [--text text.json]'); process.exit(2); }
  const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  console.log(describeChart(readJson(a[0]), flag('text', null) ? readJson(flag('text')) : null));
}
