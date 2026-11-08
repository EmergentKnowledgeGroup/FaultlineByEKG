// Faultline Lua reader: a light line scanner (no full parser). Embedded Lua scripts are common in TS/JS job and cache code.
// Finds functions, branches, loops, returns, error calls, redis commands, and @include links between scripts.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);
const STD = /^(?:assert|error|ipairs|pairs|next|select|tonumber|tostring|type|unpack|rawget|rawset|setmetatable|getmetatable|pcall|xpcall|print|loadstring|redis\.[\w.]+|cjson\.\w+|cmsgpack\.\w+|struct\.\w+|bit\.\w+|string\.\w+|table\.\w+|math\.\w+|os\.\w+)$/;
const COUNT = /attempt|tries|retry|count|limit|max|remaining|left|deadline|timeout|len|size|idx|index|^[ijkn]$/i;
const short = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 3).trimEnd() + '...'; };
const sha16 = (lines, a, b) => crypto.createHash('sha256').update(lines.slice(a - 1, b).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim() && !l.trim().startsWith('--')).join('\n')).digest('hex').slice(0, 16);

/** Blank out comments and string contents, keeping line structure. Returns {clean, comments}. */
function strip(text) {
  const out = [];
  const comments = [];
  let i = 0, line = 1, buf = '';
  const n = text.length;
  const pushCh = (c) => { if (c === '\n') { out.push(buf); buf = ''; line++; } else buf += c; };
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const m = /^--\[(=*)\[/.exec(text.slice(i, i + 12));
      if (m) {
        const close = ']' + m[1] + ']';
        const j = text.indexOf(close, i + m[0].length);
        const end = j < 0 ? n : j + close.length;
        comments.push({ line, text: text.slice(i, end) });
        for (let k = i; k < end; k++) pushCh(text[k] === '\n' ? '\n' : ' ');
        i = end;
      } else {
        let j = text.indexOf('\n', i); if (j < 0) j = n;
        comments.push({ line, text: text.slice(i, j) });
        buf += ' '.repeat(j - i); i = j;
      }
    } else if (c === '"' || c === "'") {
      buf += c; i++;
      while (i < n && text[i] !== c && text[i] !== '\n') { if (text[i] === '\\') { buf += ' '; i++; } buf += ' '; i++; }
      if (i < n && text[i] === c) { buf += c; i++; }
    } else if (c === '[' && /^\[=*\[/.test(text.slice(i, i + 10))) {
      const m = /^\[(=*)\[/.exec(text.slice(i, i + 10));
      const close = ']' + m[1] + ']';
      const j = text.indexOf(close, i + m[0].length);
      const end = j < 0 ? n : j + close.length;
      for (let k = i; k < end; k++) pushCh(text[k] === '\n' ? '\n' : ' ');
      i = end;
    } else { pushCh(c); i++; }
  }
  out.push(buf);
  return { clean: out, comments };
}

function scanFile(rel, text) {
  const raw = text.split(/\r\n|\r|\n/);
  const { clean, comments } = strip(text);
  const includes = [];
  for (const c of comments) { const m = /@include\s+["']([^"']+)["']/.exec(c.text); if (m) includes.push(m[1]); }
  const defs = [];                       // finished function records
  const mk = (qual, line) => ({ qual, line, end: raw.length, branches: [], returns: [], raises: [], excepts: [], loops: [], retryHints: [], emits: [], rawCalls: [], ops: new Set() });
  const main = mk('<script>', 1);
  const stack = [];                      // open blocks
  let pendingIf = null, pendingFor = null;
  const cur = () => { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].kind === 'function' && stack[i].def) return stack[i].def; return main; };
  const closeArm = (fr, line, firstOnLine) => {
    const a = fr.arm; if (!a) return;
    a.to = firstOnLine ? line - 1 : line; if (a.to < a.from) a.to = a.from;
    a.row.then = a.row.then || null;
    if (a.isElse) { fr.rows[0].else = [a.from, a.to]; fr.rows[0].et = a.term(); } else { a.row.then = a.row.then || [a.from, a.to]; a.row.tt = a.term(); }
    fr.arm = null;
  };
  for (let li = 0; li < clean.length; li++) {
    const line = li + 1, c = clean[li], r = raw[li] || '';
    const ms = [...c.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*|\S/g)];
    const toks = ms.map((m) => m[0]), idxs = ms.map((m) => m.index);
    for (const m of r.matchAll(/redis\.p?call\(\s*['"]([A-Za-z]+)['"]/g)) cur().ops.add(m[1].toUpperCase());
    for (let t = 0; t < toks.length; t++) {
      const w = toks[t], next = toks[t + 1], firstOnLine = t === 0;
      if (pendingIf && w !== 'then') continue;
      if (w === 'function') {
        let name = null;
        if (next && /^[A-Za-z_]/.test(next) && toks[t + 2] === '(') name = next;
        else if (toks[t - 1] === '=' && toks[t - 2] && /^[A-Za-z_][\w.]*$/.test(toks[t - 2])) name = toks[t - 2];
        const fr = { kind: 'function', line, def: null };
        if (name) { fr.def = mk(name, line); }
        stack.push(fr); if (name) t += next && /^[A-Za-z_]/.test(next) ? 1 : 0;
      } else if (w === 'if' || w === 'elseif') {
        let fr;
        if (w === 'if') { fr = { kind: 'if', line, rows: [], arm: null }; stack.push(fr); }
        else { fr = stack[stack.length - 1]; if (!fr || fr.kind !== 'if') continue; closeArm(fr, line, firstOnLine); }
        const row = { line, kind: w === 'if' ? 'if' : 'elif', test: '', end: line, then: null, tk: 'other', tt: 'other', et: 'none' };
        fr.rows.push(row);
        pendingIf = { fr, row, line, col: idxs[t] + w.length };
      } else if (w === 'then' && pendingIf) {
        const { fr, row, line: sl, col } = pendingIf; pendingIf = null;
        const text = sl === line ? r.slice(col, idxs[t]) : [raw[sl - 1].slice(col), ...raw.slice(sl, line - 1), r.slice(0, idxs[t])].join(' ');
        row.test = short(text, 80);
        row.tk = /\bnot\b|==\s*nil|~=\s*nil/.test(row.test) && !/[<>]/.test(row.test) ? 'none' : /[<>=~]/.test(row.test) ? 'cmp' : /\(/.test(row.test) ? 'call' : 'none';
        const lastOnLine = t === toks.length - 1;
        fr.arm = { row, from: lastOnLine ? line + 1 : line, isElse: false, lastKw: 'other', kwLine: line, term() { return this.lastKw; } };
        cur().branches.push(row);
      } else if (w === 'else') {
        const fr = stack[stack.length - 1];
        if (fr && fr.kind === 'if') { closeArm(fr, line, firstOnLine); fr.arm = { row: fr.rows[0], from: t === toks.length - 1 ? line + 1 : line, isElse: true, lastKw: 'other', term() { return this.lastKw; } }; }
      } else if (w === 'for' || w === 'while') {
        const fr = { kind: 'loop', line, expectDo: true, loopKind: w, text: toks.slice(t + 1).join(' ') };
        stack.push(fr);
      } else if (w === 'do') {
        const fr = stack[stack.length - 1];
        if (fr && fr.kind === 'loop' && fr.expectDo) { fr.expectDo = false; fr.text = toks.slice(toks.indexOf(fr.loopKind) + 1, t).join(' ') || fr.text; }
        else stack.push({ kind: 'do', line });
      } else if (w === 'repeat') stack.push({ kind: 'repeat', line, loopKind: 'repeat' });
      else if (w === 'until') {
        const fr = stack.pop();
        if (fr && fr.kind === 'repeat') cur().loops.push({ line: fr.line, end: line, kind: 'repeat', bounded: /\bfalse\b/.test(toks.slice(t + 1).join(' ')) ? false : true, why: 'repeat until ' + short(toks.slice(t + 1).join(' '), 40), test: short(toks.slice(t + 1).join(' '), 50) });
      } else if (w === 'end') {
        const fr = stack.pop();
        if (!fr) continue;
        if (fr.kind === 'if') { closeArm(fr, line, firstOnLine); for (const rw of fr.rows) rw.end = line; }
        else if (fr.kind === 'loop') {
          const txt = (fr.text || '').replace(/\s+/g, ' ');
          let bounded = true, why = 'loop over a list or numeric range';
          if (fr.loopKind === 'while') { if (/^\(?\s*true\s*\)?$/.test(txt)) { bounded = false; why = 'while true; no count or limit'; } else if (!/[<>]/.test(txt) || !COUNT.test(txt)) { bounded = false; why = 'no count or limit in the loop test'; } else why = 'test compares against a count or limit'; }
          cur().loops.push({ line: fr.line, end: line, kind: fr.loopKind === 'while' ? 'while' : 'for', bounded, why, test: short(txt, 50) });
        } else if (fr.kind === 'function' && fr.def) { fr.def.end = line; defs.push(fr.def); }
      } else if (w === 'return') {
        const expr = short(r.slice(r.indexOf('return') + 6).replace(/;\s*$/, ''), 80);
        const d = cur();
        d.returns.push({ line, expr });
        const rowEmit = /^-?\d+$/.test(expr) ? expr : /^["'][A-Za-z0-9_.:-]{2,40}["']$/.test(expr) ? expr.slice(1, -1) : null;
        if (rowEmit !== null && rowEmit !== '0' && rowEmit !== '1') d.emits.push({ line, kind: 'return', value: rowEmit });
        if (/redis\.error_reply/.test(expr)) d.raises.push({ line, type: 'error_reply', caught: false, msg: short(expr, 60) });
        for (const fr of stack) if (fr.arm) { fr.arm.lastKw = 'return'; }
      } else if (w === 'error' && next === '(') {
        cur().raises.push({ line, type: 'error', caught: stack.some((f) => f.kind === 'function' && f.pcall), msg: short(r.slice(r.indexOf('error(')), 60) });
        for (const fr of stack) if (fr.arm) fr.arm.lastKw = 'raise';
      } else if (w === 'break') { for (const fr of stack) if (fr.arm) fr.arm.lastKw = 'break'; }
      else if (next === '(' && !KEYWORDS.has(w) && toks[t - 1] !== 'function' && !STD.test(w)) cur().rawCalls.push([w, line]);
      else if (/^[A-Za-z_]/.test(w) && !KEYWORDS.has(w)) { for (const fr of stack) if (fr.arm && fr.arm.kwLine !== line) fr.arm.lastKw = 'other'; }
    }
  }
  main.end = raw.length;
  return { raw, includes, defs, main, comments };
}

export async function readLua(rootDir, files) {
  const t0 = Date.now();
  const modules = [], functions = {}, skipped = [], luaScripts = new Map();
  const scanned = new Map();
  const paths = new Set(files.map((f) => f.path));
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(rootDir, f.path));
      const text = buf.toString('utf8');
      const s = scanFile(f.path, text);
      s.sha = crypto.createHash('sha256').update(buf).digest('hex');
      scanned.set(f.path, s);
    } catch (e) { skipped.push({ path: f.path, why: short(`${e.name}: ${e.message}`, 160) }); }
  }
  const resolveInclude = (from, inc) => {
    const dir = path.posix.dirname(from);
    for (const base of [dir, dir + '/includes', path.posix.dirname(dir), path.posix.dirname(dir) + '/includes']) {
      const p = path.posix.normalize(`${base}/${inc}${inc.endsWith('.lua') ? '' : '.lua'}`);
      if (paths.has(p)) return p;
    }
    return null;
  };
  for (const [p, s] of scanned) s.incPaths = s.includes.map((i) => resolveInclude(p, i)).filter(Boolean);
  const closure = (p, seen = new Set()) => { if (seen.has(p)) return seen; seen.add(p); for (const q of scanned.get(p)?.incPaths || []) closure(q, seen); return seen; };
  const defIndex = new Map();            // path -> Map(name -> id)
  for (const [p, s] of scanned) { const m = new Map(); for (const d of s.defs) if (!m.has(d.qual)) m.set(d.qual, `${p}::${d.qual}`); defIndex.set(p, m); }
  for (const [p, s] of scanned) {
    const fileClosure = [...closure(p)];
    const uniqQual = new Map();
    for (const d of [...s.defs, s.main]) {
      const n = (uniqQual.get(d.qual) || 0) + 1; uniqQual.set(d.qual, n);
      const qual = n === 1 ? d.qual : `${d.qual}~${n}`;
      const id = `${p}::${qual}`;
      const callIdx = new Map(), callAt = [];
      for (const [name, line] of d.rawCalls) {
        let target = null;
        for (const q of fileClosure) { const hit = defIndex.get(q)?.get(name); if (hit) { target = hit; break; } }
        if (target && target !== id) { if (!callIdx.has(target)) callIdx.set(target, callIdx.size); const row = [callIdx.get(target), line]; if (!callAt.some((x) => x[0] === row[0] && x[1] === row[1])) callAt.push(row); }
      }
      const rec = { path: p, qual, line: d.line, end: d.end, sha256: sha16(s.raw, d.line, d.end), doc: '', async: false, decorators: [], calls: [...callIdx.keys()], unresolved: [],
        branches: d.branches.slice(0, 400), returns: d.returns.slice(0, 300), raises: d.raises.slice(0, 100), excepts: [], loops: d.loops.slice(0, 100), retryHints: [] };
      if (callAt.length) rec.callAt = callAt;
      if (d.emits.length) rec.emits = d.emits.slice(0, 100);
      if (d.ops.size) rec.redisOps = [...d.ops].sort();
      if (rec.calls.length || rec.branches.length || rec.returns.length || rec.redisOps || d.qual !== '<script>') functions[id] = rec;
    }
    const isInclude = /(?:^|\/)includes\//.test(p);
    const base = path.posix.basename(p, '.lua').replace(/-\d+$/, '');
    if (!isInclude && !luaScripts.has(base)) luaScripts.set(base, `${p}::<script>`);
    const doc = s.comments.map((c) => c.text.replace(/^--+\s*(\[=*\[)?|\]=*\]$/g, '').trim()).find((x) => x && !x.startsWith('@') && !/^(?:input|output|key|arg)/i.test(x)) || '';
    modules.push({ path: p, lang: 'lua', lines: s.raw.length, sha256: s.sha, imports: [...new Set(s.incPaths)].filter((x) => x !== p).sort(), externalImports: [], doc: short(doc, 120) });
  }
  return { modules, functions, entries: [], switches: [], enums: [], skipped, luaScripts, stats: { seconds: +((Date.now() - t0) / 1000).toFixed(2), files: files.length } };
}
