// Faultline TS/JS reader: facts for .ts .tsx .mts .cts .js .jsx .mjs .cjs using the TypeScript parser (no type checker).
// Two passes: a definition index over every file, then a full read of each file against it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { TsIndex, collectDefs, lineOf, loadTs, parse, propChain, readAliases, unwrap } from './ts_index.mjs';
import { buildMod, hasMod } from './ts_mod.mjs';
import { Scan, short } from './ts_scan.mjs';
import './ts_visit.mjs';

const CONST_VOCAB = /(?:^|_)(?:MAX|MIN|LIMIT|LIMITS|TIMEOUT|RETRIES|RETRY|ATTEMPTS|BACKOFF|INTERVAL|TTL|THRESHOLD|ENABLE|ENABLED|DISABLE|DISABLED|DEBUG|DRY_RUN|FEATURE|FLAG|BATCH|CAP|LEASE|DELAY|PERIOD|WINDOW|QUOTA|BUDGET|DEADLINE|EXPERIMENTAL|LOCK|STALLED|DURATION|CONCURRENCY)(?:$|_)/;
const OPTS_NAME = /default|options|config|settings|opts/i;
const DECO_ROUTE = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'All', 'Head', 'Options']);
const DECO_HANDLER = new Set(['MessagePattern', 'EventPattern', 'Process', 'OnEvent', 'Cron', 'Interval', 'Timeout', 'Subscribe', 'Listen', 'Command', 'SubscribeMessage', 'OnQueueEvent', 'Processor', 'OnWorkerEvent', 'Hook']);
const TEST_BLOCK = new Set(['describe', 'context', 'suite']);
const TEST_CASE = new Set(['it', 'test', 'specify', 'bench']);
const LABEL = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{1,39}$/;
export const TS_LANG = { '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts', '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js' };

function enumRows(ts, sf, rel, lineAt) {
  const rows = [];
  const lit = (e) => { e = unwrap(ts, e); return e && ts.isStringLiteralLike(e) ? e.text : e && ts.isNumericLiteral(e) ? e.text : null; };
  for (const s of sf.statements) {
    if (ts.isEnumDeclaration(s)) {
      const members = [], values = [];
      for (const m of s.members) { const nm = m.name.text ?? m.name.getText(sf); members.push(nm); values.push(lit(m.initializer) ?? nm.toLowerCase()); }
      if (members.length) rows.push({ name: s.name.text, path: rel, line: lineAt(s.getStart(sf)), values, members, form: 'enum' });
    } else if (ts.isTypeAliasDeclaration(s) && ts.isUnionTypeNode(s.type)) {
      const vals = s.type.types.filter((t) => ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)).map((t) => t.literal.text);
      if (vals.length >= 2 && vals.length === s.type.types.length) rows.push({ name: s.name.text, path: rel, line: lineAt(s.getStart(sf)), values: vals, members: [], form: 'literal' });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        let v = d.initializer && unwrap(ts, d.initializer);
        if (v && ts.isCallExpression(v) && (propChain(ts, v.expression) || []).join('.') === 'Object.freeze' && v.arguments[0]) v = unwrap(ts, v.arguments[0]);
        if (!(ts.isIdentifier(d.name) && v && ts.isObjectLiteralExpression(v))) continue;
        const members = [], values = [];
        let ok = true;
        for (const p of v.properties) {
          const l = ts.isPropertyAssignment(p) ? lit(p.initializer) : null;
          if (l === null || !p.name) { ok = false; break; }
          members.push(p.name.text ?? p.name.getText(sf)); values.push(l);
        }
        if (ok && members.length >= 3 && values.every((x) => LABEL.test(x)) && /^[A-Z]/.test(d.name.text)) rows.push({ name: d.name.text, path: rel, line: lineAt(d.getStart(sf)), values, members, form: 'const-object' });
      }
    }
  }
  return rows;
}

function constSwitches(ts, sf, mi, lineAt, acc) {
  const lit = (e) => { e = unwrap(ts, e); return e && (ts.isNumericLiteral(e) || ts.isStringLiteralLike(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) ? (ts.isStringLiteralLike(e) ? e.text : e.getText(sf)) : null; };
  const add = (name, node, def, kind) => acc.switches.push({ name, path: mi.path, line: lineAt(node.getStart(sf)), default: def, kind, fn: null });
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const nm = d.name.text, v = unwrap(ts, d.initializer), l = lit(v);
        if (l !== null && l.length <= 40 && /^[A-Z][A-Z0-9_]*$/.test(nm) && CONST_VOCAB.test(nm)) add(nm, d, l, 'const');
        else if (ts.isObjectLiteralExpression(v) && OPTS_NAME.test(nm)) {
          for (const p of v.properties) if (ts.isPropertyAssignment(p) && p.name && p.name.text) { const pl = lit(p.initializer); if (pl !== null && pl.length <= 40) add(p.name.text, p, pl, 'config'); }
        }
      }
    } else if (ts.isClassDeclaration(s)) {
      for (const m of s.members) {
        if (ts.isPropertyDeclaration(m) && m.initializer && m.name && m.name.text && hasMod(m, ts.SyntaxKind.StaticKeyword)) {
          const l = lit(m.initializer);
          if (l !== null && l.length <= 40 && (CONST_VOCAB.test(m.name.text.toUpperCase()) || /^[A-Z][A-Z0-9_]*$/.test(m.name.text) && CONST_VOCAB.test(m.name.text))) add(m.name.text, m, l, 'const');
        }
      }
    }
  }
}

function fileDoc(ts, sf) {
  const text = sf.text, start = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
  for (const r of ts.getLeadingCommentRanges(text, start) || []) {
    const t = text.slice(r.pos, r.end);
    if (/licen[sc]e|copyright|\(c\)|permission is hereby/i.test(t)) continue;
    const line = t.replace(/^\/\*+|\*+\/$/g, '').split('\n').map((l) => l.replace(/^\s*(\*|\/\/+)\s?/, '').trim()).find((l) => l && !l.startsWith('@'));
    if (line) return short(line, 120);
  }
  return '';
}

function decoEntries(ts, d, mi, acc) {
  for (const dec of ts.getDecorators?.(d.node) || []) {
    const e = dec.expression, call = ts.isCallExpression(e) ? e : null;
    const nm = (call ? call.expression : e).getText?.() || '';
    const arg = call && call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) ? call.arguments[0].text : '';
    const id = `${mi.path}::${d.qual}`;
    if (DECO_ROUTE.has(nm)) acc.entries.push({ fn: id, kind: 'route', why: `@${nm}(${arg})` });
    else if (DECO_HANDLER.has(nm)) acc.entries.push({ fn: id, kind: 'handler', why: `@${nm}` });
  }
}

function testEntries(env, mi, sf, lines, lineAt, acc) {
  const { ts } = env;
  const out = [];
  const visit = (n, names) => {
    if (ts.isCallExpression(n)) {
      const c = unwrap(ts, n.expression);
      const head = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : '';
      const a0 = n.arguments[0], cb = n.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      const title = a0 && ts.isStringLiteralLike(a0) ? a0.text : '';
      if (TEST_BLOCK.has(head) && cb) { ts.forEachChild(cb.body, (k) => visit(k, [...names, title])); return; }
      if (TEST_CASE.has(head) && cb) {
        const sc = new Scan(env, mi, sf, lines, lineAt, { node: cb, qual: '<test>', cls: null, parent: null }, { entries: [], switches: [], enumUses: {} }, new Map());
        const rec = sc.run();
        out.push({ fn: `${mi.path}::${short([...names, title].join(' > '), 90)}`, kind: 'test', why: `${head}('${short(title, 40)}')`, line: lineAt(n.getStart(sf)), calls: rec.calls });
        return;
      }
    }
    ts.forEachChild(n, (k) => visit(k, names));
  };
  for (const s of sf.statements) visit(s, []);
  return out;
}

function mainGuardEntries(env, mi, sf, lines, lineAt, acc, children) {
  const { ts } = env;
  for (const s of sf.statements) {
    if (!ts.isIfStatement(s) || !/require\.main\s*===\s*module|import\.meta\.main/.test(s.expression.getText(sf))) continue;
    const sc = new Scan(env, mi, sf, lines, lineAt, { node: { statements: [s.thenStatement] }, qual: '<module>', cls: null, parent: null }, { entries: [], switches: [], enumUses: {} }, children, true);
    for (const c of sc.run().calls) acc.entries.push({ fn: c, kind: 'main', why: `main-module guard (line ${lineAt(s.getStart(sf))})` });
  }
}

// Public surface: package index files, plus source modules that export something and that no other source module imports.
function packageEntryFiles(ix, files) {
  const names = files.filter((f) => f.role === 'src').map((f) => f.path);
  const imported = new Set();
  for (const p of names) {
    const mi = ix.mods.get(p);
    if (!mi) continue;
    for (const im of mi.rawImports) if (im.target) imported.add(im.target);
    for (const r of mi.reexports.values()) { const t = ix.resolveFile(p, r.spec); if (t) imported.add(t); }
    for (const sp of mi.stars) { const t = ix.resolveFile(p, sp); if (t) imported.add(t); }
  }
  return names.filter((p) => /^(?:src\/|lib\/)?index\.(?:ts|tsx|mts|js|mjs|cjs)$/.test(p) || (ix.mods.get(p) && ix.mods.get(p).exports.size > 0 && !imported.has(p)));
}

function allExports(ix, p, depth = 0, seen = new Set()) {
  const mi = ix.mods.get(p);
  if (!mi || depth > 6 || seen.has(p)) return [];
  seen.add(p);
  const names = new Set([...mi.exports.keys(), ...mi.reexports.keys()]);
  for (const s of mi.stars) { const t = ix.resolveFile(p, s); if (t) for (const n of allExports(ix, t, depth + 1, seen)) names.add(n); }
  names.delete('default');
  return [...names];
}

export async function readTs(rootDir, files, { luaScripts = new Map(), ts: tsIn = null } = {}) {
  const t0 = Date.now();
  const ts = tsIn || await loadTs(rootDir);
  if (!ts) return { modules: [], functions: {}, entries: [], switches: [], enums: [], skipped: files.map((f) => ({ path: f.path, why: "the 'typescript' package is not installed" })), stats: { seconds: 0 } };
  const ix = new TsIndex(rootDir, files.map((f) => f.path), readAliases(ts, rootDir));
  const skipped = [], roles = new Map(files.map((f) => [f.path, f.role]));
  const env = { ts, ix, luaScripts, defNodes: new Set() };
  const okFiles = [];
  for (const f of files) {                                    // pass 1
    try {
      const text = fs.readFileSync(path.join(rootDir, f.path), 'utf8');
      const sf = parse(ts, f.path, text, f.path);
      const { mi } = buildMod(ts, sf, f.path, lineOf(sf));
      mi.enumRows = enumRows(ts, sf, f.path, lineOf(sf));
      ix.add(mi, f.role === 'src');
      if (f.role === 'src') for (const e of mi.enumRows) if (e.form === 'enum' || e.form === 'const-object') ix.enumNames.add(e.name);
      okFiles.push(f);
    } catch (e) { skipped.push({ path: f.path, why: short(`${e.name}: ${e.message}`, 160) }); }
  }
  ix.link();
  const acc = { entries: [], switches: [], enumUses: {} };
  const modules = [], functions = {}, enums = [];
  for (const f of okFiles) {                                  // pass 2
    try {
      const raw = fs.readFileSync(path.join(rootDir, f.path));
      const text = raw.toString('utf8');
      const sf = parse(ts, f.path, text, f.path), lineAt = lineOf(sf), lines = text.split(/\r\n|\r|\n/);
      const mi = ix.mods.get(f.path), defs = collectDefs(ts, sf);
      env.defNodes = new Set(defs.map((d) => d.node));
      const children = new Map();
      for (const d of defs) if (d.kind === 'func' && d.parent) { if (!children.has(d.parent)) children.set(d.parent, new Map()); children.get(d.parent).set(d.name, d.qual); }
      if (f.role === 'test') { acc.entries.push(...testEntries(env, mi, sf, lines, lineAt, acc)); continue; }
      const local = {};
      for (const d of defs) {
        if (d.kind !== 'func') continue;
        const rec = new Scan(env, mi, sf, lines, lineAt, d, acc, children).run();
        local[`${f.path}::${d.qual}`] = rec;
        decoEntries(ts, d, mi, acc);
      }
      const mrec = new Scan(env, mi, sf, lines, lineAt, { node: sf, qual: '<module>', cls: null, parent: null }, acc, children, true).run();
      const exec = text.startsWith('#!') || /(?:^|\/)(?:bin|scripts)\//.test(f.path) || /(?:^|\/)(?:main|cli|server|app|worker)\.[a-z]+$/.test(f.path);
      if (exec) for (const c of mrec.calls) acc.entries.push({ fn: c, kind: 'main', why: 'top-level call in an executable script' });
      mainGuardEntries(env, mi, sf, lines, lineAt, acc, children);
      if (mrec.calls.length || mrec.branches.length) local[`${f.path}::<module>`] = mrec;
      Object.assign(functions, local);
      constSwitches(ts, sf, mi, lineAt, acc);
      enums.push(...mi.enumRows);
      const imps = new Set(), ext = new Set();
      for (const im of mi.rawImports) { if (im.target && im.target !== f.path) imps.add(im.target); else if (im.ext) ext.add(im.ext); }
      modules.push({ path: f.path, lang: TS_LANG[path.extname(f.path)] || 'js', lines: sf.getLineStarts().length, sha256: crypto.createHash('sha256').update(raw).digest('hex'), imports: [...imps].sort(), externalImports: [...ext].sort(), doc: fileDoc(ts, sf) });
    } catch (e) { skipped.push({ path: f.path, why: short(`${e.name} while reading: ${e.message}`, 160) }); }
  }
  let nExports = 0;
  for (const ep of packageEntryFiles(ix, okFiles)) {
    for (const nm of allExports(ix, ep)) {
      const r = ix.exportOf(ep, nm);
      if (!r || nExports > 600) continue;
      if (r[0] === 'func') { acc.entries.push({ fn: r[1], kind: 'export', why: `exported from ${ep}` }); nExports++; }
      else if (r[0] === 'class') {
        const mi = ix.mods.get(r[1]), ci = mi && mi.classes.get(r[2]);
        if (!ci) continue;
        for (const [m, q] of ci.methods) if (!ci.hidden.has(m) && !m.startsWith('_') && !m.startsWith('#')) { acc.entries.push({ fn: `${r[1]}::${q}`, kind: 'export', why: `public method of ${ci.name}, exported from ${ep}` }); nExports++; }
      }
    }
  }
  for (const e of enums) if (e.form === 'enum' || e.form === 'const-object') e.uses = Object.fromEntries(e.members.map((m) => [m, acc.enumUses[`${e.name}.${m}`] || 0]));
  const seen = new Set(), entries = [];
  for (const e of acc.entries) { const k = e.fn + '|' + e.kind; if (!seen.has(k)) { seen.add(k); entries.push(e); } }
  const classBases = {};
  for (const m of ix.mods.values()) if (roles.get(m.path) === 'src') for (const ci of m.classes.values()) if (ci.bases.length && !classBases[ci.name]) classBases[ci.name] = ci.bases.map((b) => b.split('.').pop());
  return { modules, functions, entries, switches: acc.switches, enums, classBases, skipped, stats: { seconds: +((Date.now() - t0) / 1000).toFixed(2), files: files.length } };
}
