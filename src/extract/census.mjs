// census.json builder: a floor taken from code. Counts endings through outcome types, weighs branches, finds passes, lists switches.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const DISPLAY_FN = /(?:(?:^|\.)(?:__str__|__repr__|__format__|label|describe|title|name|display|to_?s(?:tr)?|text|toString|toJSON|__eq__|__hash__|format\w*|fmt\w*|humanize\w*|pretty\w*|render\w*|get_?label\w*|get_?name\w*|get_?title\w*)|(?:Label|Labels|Title|Caption|Display|Text|Description|Summary|Blurb|Heading|Tooltip)|_(?:label|title|caption|text|description|summary|heading))$/;
const OUTCOME_NAME = /(?:Status|State|Outcome|Result|Verdict|Reason|Disposition|Resolution|Decision|Phase|Refusal|Failure)s?$/;
const OS_ENV = new Set(['PROGRAMFILES(X86)', 'PROGRAMFILES', 'SYSTEMROOT', 'WINDIR', 'LOCALAPPDATA', 'PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SHELL', 'LANG', 'USER', 'USERNAME', 'PWD', 'OS', 'COMSPEC', 'PATHEXT', 'SYSTEMROOT', 'HOSTNAME', 'TERM', 'DISPLAY', 'PYTHONPATH', 'VIRTUAL_ENV', 'PROGRAMFILES', 'PROGRAMDATA', 'LOGNAME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'CI', 'NODE_ENV']);
const TRIVIAL_TEST = /__name__|TYPE_CHECKING|sys\.platform|sys\.version|os\.name\b|typeof (?:window|document)|import\.meta|NODE_ENV|process\.platform|require\.main/;
const TOGGLE_NAME = /ENABLE|DISABLE|DEBUG|DRY_RUN|FAST|EXPERIMENTAL|BETA|FEATURE|FLAG|ALLOW|^USE_|_USE_|SKIP|FORCE|VERBOSE|TRACE|MOCK|STRICT|ACTIVE|AUTORUN/i;
const FALSY = new Set(['0', 'false', 'no', 'off', 'none', 'null', '', 'undefined', 'nil', "''", '""']);
const TRUTHY_CMP = /^(?:==|===|in)\s*[(\['"]*\s*(?:1|true|yes|on)\b/i;
const STDLIB_PARENTS = { KeyError: 'LookupError', IndexError: 'LookupError', FileNotFoundError: 'OSError', PermissionError: 'OSError', TimeoutError: 'OSError',
  ConnectionError: 'OSError', IOError: 'OSError', JSONDecodeError: 'ValueError', UnicodeDecodeError: 'ValueError', LookupError: 'Exception', OSError: 'Exception',
  ValueError: 'Exception', TypeError: 'Exception', RuntimeError: 'Exception', AttributeError: 'Exception' };

const inRange = (line, r) => !!r && line >= r[0] && line <= r[1];

export function buildCensus(facts, graph) {
  const fns = facts.functions, ids = Object.keys(fns).sort();
  const classBases = facts.classBases || {};
  const entryIds = new Set(facts.entries.filter((e) => e.kind !== 'test').map((e) => e.fn));
  const depth = graph.depth || {};

  // ---- outcome types ------------------------------------------------------------------------
  const used = { members: new Set(), values: new Set() };
  const slotValues = new Map(), fnReturns = new Map();
  const emitsOf = (id) => fns[id].emits || [];
  for (const id of ids) {
    if (DISPLAY_FN.test(fns[id].qual) || id.endsWith('::<module>')) continue;
    for (const e of emitsOf(id)) {
      if (e.enum) used.members.add(e.enum + '.' + e.member);
      if (e.value != null) {
        used.values.add(e.value);
        if (e.slot && e.kind !== 'return') { if (!slotValues.has(e.slot)) slotValues.set(e.slot, { vals: new Set(), sites: 0, id, line: e.line, path: fns[id].path }); const s = slotValues.get(e.slot); s.vals.add(e.value); s.sites++; }
        if (e.kind === 'return' || e.kind === 'tuple') { if (!fnReturns.has(id)) fnReturns.set(id, new Set()); fnReturns.get(id).add(e.value); }
      }
    }
  }
  const outcomeTypes = [], typeOfEnum = new Set(), knownValues = new Set();
  for (const en of facts.enums) {
    const members = en.members || [];
    const memberUsed = members.some((m) => used.members.has(en.name.split('.').pop() + '.' + m));
    const valueUsed = (en.values || []).some((v) => used.values.has(v));
    if (!(OUTCOME_NAME.test(en.name) || memberUsed || valueUsed)) continue;
    const row = { name: en.name, source: en.form === 'enum' ? 'enum' : 'declared', path: en.path, line: en.line, values: en.values };
    if (en.uses) { const unused = members.filter((m) => !en.uses[m]).map((m) => en.values[members.indexOf(m)]); if (unused.length) row.unused = unused; }
    outcomeTypes.push(row);
    typeOfEnum.add(en.name.split('.').pop());
    for (const v of en.values || []) knownValues.add(v);
  }
  for (const [slot, s] of [...slotValues].sort((a, b) => cmp(a[0], b[0]))) {
    if (s.vals.size >= 2 && s.sites >= 2) { outcomeTypes.push({ name: slot, source: 'inferred', path: s.path, line: s.line, values: [...s.vals].sort() }); for (const v of s.vals) knownValues.add(v); }
  }
  for (const [id, vals] of [...fnReturns].sort((a, b) => cmp(a[0], b[0]))) {
    if (vals.size >= 2) { const f = fns[id]; outcomeTypes.push({ name: f.qual + '()', source: 'inferred', path: f.path, line: f.line, values: [...vals].sort() }); }
  }
  const valueCount = new Map();
  for (const id of ids) for (const e of emitsOf(id)) if (e.value != null) valueCount.set(e.value, (valueCount.get(e.value) || 0) + 1);

  // ---- which raises escape an entry ------------------------------------------------------------
  const blockedBy = new Map();                // fn -> Map(callee -> Set(types) | null when some site is open)
  const sitesOf = (id) => {
    const f = fns[id], m = new Map();
    for (const r of f.callAt || []) {
      const callee = f.calls[r[0]]; if (!callee) continue;
      const cur = m.has(callee) ? m.get(callee) : undefined;
      if (!r[2]) m.set(callee, null);
      else if (cur !== null) { const s = cur || new Set(); for (const t of r[2].split('|')) s.add(t); m.set(callee, s); }
    }
    return m;
  };
  for (const id of ids) blockedBy.set(id, sitesOf(id));
  const catches = (set, type) => {
    if (!set) return false;
    if (set.has('*') || set.has(type)) return true;
    for (let p = classBases[type] ? classBases[type][0] : STDLIB_PARENTS[type], i = 0; p && i < 8; p = classBases[p] ? classBases[p][0] : STDLIB_PARENTS[p], i++) if (set.has(p)) return true;
    return false;
  };
  const escapeCache = new Map();
  const escapeDist = (type) => {
    if (escapeCache.has(type)) return escapeCache.get(type);
    const dist = new Map();
    let frontier = [...entryIds].filter((e) => fns[e]).sort();
    for (const e of frontier) dist.set(e, 0);
    for (let d = 1; frontier.length; d++) {
      const next = [];
      for (const u of frontier) {
        const bm = blockedBy.get(u);
        for (const v of [...(fns[u].calls || []), ...(fns[u].weakCalls || [])]) {
          if (dist.has(v) || !fns[v]) continue;
          if (bm && bm.has(v) && catches(bm.get(v), type)) continue;
          dist.set(v, d); next.push(v);
        }
      }
      frontier = next.sort();
    }
    escapeCache.set(type, dist);
    return dist;
  };

  // ---- endings -------------------------------------------------------------------------------------
  const endings = [];
  let droppedLow = 0;
  for (const id of ids) {
    const isModule = id.endsWith('::<module>');
    if (isModule && !(fns[id].exits || []).length) continue;
    const f = fns[id], rows = [], seen = new Set();
    const display = DISPLAY_FN.test(f.qual);
    const push = (line, kind, value, confidence, extra) => {
      const k = (kind === 'outcome' || kind === 'status' ? 'v' : kind) + '|' + value;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push({ line, kind, value, confidence, ...extra });
    };
    const distinctReturns = fnReturns.get(id) ? fnReturns.get(id).size : 0;
    const slotDiv = new Map();
    for (const e of emitsOf(id)) if (e.slot && e.kind !== 'return') { if (!slotDiv.has(e.slot)) slotDiv.set(e.slot, new Set()); slotDiv.get(e.slot).add(e.enum ? e.enum + '.' + e.member : e.value); }
    if (!display && !isModule) {
      for (const e of [...emitsOf(id)].sort((a, b) => (a.kind === 'return' ? 0 : 1) - (b.kind === 'return' ? 0 : 1) || a.line - b.line)) {
        const val = e.enum ? `${e.enum}.${e.member}` : e.value;
        if (val == null) continue;
        const known = e.enum ? typeOfEnum.has(e.enum) : knownValues.has(e.value);
        const isReturn = e.kind === 'return' || e.kind === 'tuple' || e.kind === 'ctor';
        const selector = e.slot && !isReturn && slotDiv.get(e.slot) && slotDiv.get(e.slot).size >= 2;
        let conf = known ? 'high' : (isReturn && distinctReturns >= 2) || selector || (valueCount.get(e.value) || 0) >= 2 ? 'medium' : 'low';
        if (e.via && String(e.via).startsWith('var:') && conf === 'high') conf = 'medium';
        if (conf === 'low') { droppedLow++; continue; }
        push(e.line, isReturn ? 'outcome' : 'status', val, conf, {});
      }
    }
    for (const r of isModule ? [] : f.raises || []) {
      if (r.type === '(reraise)' || r.type === '(dynamic)' || r.caught) continue;
      const d = escapeDist(r.type).get(id);
      if (d === undefined) continue;
      let conf = d === 0 ? 'high' : d === 1 ? 'medium' : 'low';
      if (conf === 'low' && classBases[r.type] && d <= 3) conf = 'medium';
      if (conf === 'low') { droppedLow++; continue; }
      push(r.line, 'raise', r.type, conf, r.msg ? { msg: r.msg } : {});
    }
    for (const x of f.exits || []) {
      const d = depth[id];
      const modHasMain = isModule && facts.entries.some((e) => e.kind === 'main' && e.fn.startsWith(f.path + '::'));
      const conf = entryIds.has(id) || d === 0 || modHasMain ? 'high' : d !== undefined && d <= 2 ? 'medium' : 'low';
      if (conf === 'low') { droppedLow++; continue; }
      push(x.line, 'exit', `${x.via}(${x.code || ''})`, conf, {});
    }
    rows.sort((a, b) => a.line - b.line || cmp(a.kind + a.value, b.kind + b.value));
    rows.forEach((r, i) => endings.push({ id: `end:${id}:${i}`, fn: id, line: r.line, kind: r.kind, value: r.value, confidence: r.confidence, ...(r.msg ? { msg: r.msg } : {}) }));
  }

  // a status word written all over the project (failed, completed) is one way to end per module, not one per write
  const valueRows = new Map();
  for (const e of endings) if (e.kind === 'outcome' || e.kind === 'status') valueRows.set(e.value, (valueRows.get(e.value) || 0) + 1);
  const endingsAll = endings.slice();
  const grouped = new Map(), kept = [];
  for (const e of endings) {
    if ((e.kind === 'outcome' || e.kind === 'status') && valueRows.get(e.value) >= 8 && !e.value.includes('.')) {
      const key = fns[e.fn].path + '|' + e.value;
      if (grouped.has(key)) { const g = grouped.get(key); g.also.push({ fn: e.fn, line: e.line }); continue; }
      const g = { ...e, also: [] }; grouped.set(key, g); kept.push(g);
    } else kept.push(e);
  }
  for (const e of kept) if (e.also && !e.also.length) delete e.also;
  endings.length = 0; endings.push(...kept);
  // ---- branches ------------------------------------------------------------------------------------
  // A test "mentions a switch" only for specific names: env/flag reads and constants match as whole identifiers (case kept for UPPER names);
  // config keys need an underscore or 10+ letters, so words like mode, path or enabled do not make every test a decision.
  // Numeric limits are not gates: comparing against MAX_FILE_BYTES is ordinary logic, testing FAST_LANE or a mode is a decision.
  const isUpper = (n) => n === n.toUpperCase() && /[A-Z]/.test(n);
  const numericDefault = new Map();
  for (const s of facts.switches) if (/^-?[\d_.]+$/.test(String(s.default).trim()) && !(TOGGLE_NAME.test(s.name) && /^[01]$/.test(String(s.default).trim()))) numericDefault.set(s.name, true); else numericDefault.set(s.name, numericDefault.get(s.name) || false);
  const specific = (s) => !OS_ENV.has(s.name.toUpperCase()) && !numericDefault.get(s.name) && s.name.length >= 4 && (s.kind === 'env' || s.kind === 'flag' || isUpper(s.name) || s.name.includes('_') || s.name.length >= 10);
  const swNames = [...new Set(facts.switches.filter(specific).map((s) => s.name))];
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const upper = swNames.filter(isUpper), lower = swNames.filter((n) => !isUpper(n));
  const swUpper = upper.length ? new RegExp('(?<![A-Za-z0-9_])(?:' + upper.map(esc).join('|') + ')(?![A-Za-z0-9_])') : null;
  const swLower = lower.length ? new RegExp('(?<![A-Za-z0-9])(?:' + lower.map(esc).join('|') + ')(?![A-Za-z0-9])', 'i') : null;
  // the switch must be an operand of the test itself (x, not x, x == 'a', x in (...)), not just appear inside a call or sum
  const OPERAND = /^(?:not\s+|!)*\(*\s*(?:self\.|this\.|cfg\.|config\.|settings\.|[\w.?]*\.)?([A-Za-z_][\w]*)\s*\)*\s*(?:(?:===?|!==?|is not|is|not in|in)\s*\S.*)?$/;
  const swHit = (t) => {
    for (const part of t.split(/\s+(?:and|or)\s+|&&|\|\|/)) {
      const m = OPERAND.exec(part.trim());
      if (!m) continue;
      const nm = swUpper && swUpper.exec(m[1]) || swLower && swLower.exec(m[1]);
      if (nm && nm[0].length === m[1].length) return nm[0];
    }
    return null;
  };
  const handled = new Set();                   // exception types some handler in the project catches by name
  for (const id of ids) for (const x of fns[id].excepts || []) for (const t of String(x.type).split('|')) handled.add(t);
  const branches = [];
  const endingLines = new Map();
  // a bare ValueError or TypeError thrown at bad input is a precondition, not a choice between outcomes: it does not make its branch a decision
  const PLAIN_ERR = new Set(['Error', 'Exception', 'ValueError', 'TypeError', 'RuntimeError', 'KeyError', 'IndexError', 'AttributeError', 'NotImplementedError', 'AssertionError',
    'OSError', 'LookupError', 'TimeoutError', 'ArgumentTypeError', 'StopIteration', 'RangeError', 'SyntaxError', 'error', 'error_reply']);
  for (const e of endingsAll) {
    if (e.kind === 'raise' && PLAIN_ERR.has(e.value)) continue;
    if (!endingLines.has(e.fn)) endingLines.set(e.fn, []);
    endingLines.get(e.fn).push(e.line);
  }
  for (const id of ids) {
    const f = fns[id], isMod = id.endsWith('::<module>');
    const brs = (f.branches || []).slice().sort((a, b) => a.line - b.line || cmp(a.kind, b.kind));
    if (!brs.length) continue;
    const elines = endingLines.get(id) || [];
    const lines = (f.callAt || []).map((r) => r[1]);
    const arm = (r) => r ? { calls: lines.filter((l) => inRange(l, r)).length, ends: elines.filter((l) => inRange(l, r)).length, raises: (f.raises || []).filter((x) => inRange(x.line, r) && x.type !== '(reraise)').length,
      hints: (f.retryHints || []).filter((h) => inRange(h.line, r)).length, loops: (f.loops || []).filter((l) => inRange(l.line, r)).length, size: r[1] - r[0] + 1 } : { calls: 0, ends: 0, raises: 0, hints: 0, loops: 0, size: 0 };
    const rows = [], chainOf = new Map();
    for (const b of brs) {                    // an if/elif/else chain is ONE decision with several exits: weigh the head, mark the rest
      if (b.kind !== 'if') continue;
      let cur = b;
      while (cur.et === 'elif' && cur.else) {       // an elif chain never visits a branch twice: two branches written on one line must not send it round in a circle
        const nx = brs.find((x) => x.kind === 'elif' && x.line === cur.else[0]);
        if (!nx || nx === cur || chainOf.has(nx)) break;
        chainOf.set(nx, b); cur = nx;
      }
    }
    const members = new Map();
    for (const [el, head] of chainOf) { if (!members.has(head)) members.set(head, []); members.get(head).push(el); }
    let n = 0;
    for (const b of brs) {
      if (chainOf.has(b)) { rows.push({ b, w: 'guard', rule: 'chain-arm', head: chainOf.get(b).line }); continue; }
      const chain = [b, ...(members.get(b) || [])];
      const arms = chain.flatMap((c) => [arm(c.then)]).concat(chain.length > 1 || chain[chain.length - 1].et === 'elif' ? [] : [arm(chain[0].else)]);
      const last = chain[chain.length - 1];
      if (chain.length > 1 && last.else) arms.push(arm(last.else));
      const sum = (k) => arms.reduce((s, a) => s + a[k], 0);
      const ends = sum('ends'), raises = sum('raises'), calls = sum('calls'), hints = sum('hints'), loops = sum('loops');
      const callArms = arms.filter((a) => a.calls > 0).length;
      const hasElse = chain.length > 1 || !!b.else, t = arms[0] || arm(null), e0 = arm(b.else);
      const guardShape = !hasElse && ['return', 'raise', 'continue', 'break', 'exit'].includes(b.tt) && t.size <= 4;
      let w, rule, sw = null;
      const set = (weight, why) => { w = weight; rule = why; };
      if (isMod) set('trivial', 'module-level');
      else if (TRIVIAL_TEST.test(b.test)) set('trivial', 'environment-test');
      else if (b.kind === 'ternary') { if (ends > 0) set('decision', 'ending-in-arm'); else set('trivial', 'value-pick'); }
      else if (chain.some((c) => (sw = swHit(c.test)))) set('decision', 'switch-test');
      else if (b.kind === 'try') {
        if (e0.ends > 0) set('decision', 'ending-in-handler'); else if (e0.hints > 0) set('guard', 'retry-handled');
        else if (e0.raises > 0 && e0.calls > 0) set('decision', 'translate-and-act'); else if (t.calls + e0.calls > 0 || e0.size > 0) set('guard', 'error-handling'); else set('trivial', 'empty-handler');
      } else if (b.kind === 'match') { if (ends > 0) set('decision', 'ending-in-arm'); else if ((b.cases || 0) >= 3 && calls >= 2) set('decision', 'many-way-pick'); else set('trivial', 'small-match'); }
      else if (guardShape) {
        const near = depth[id] !== undefined && depth[id] <= 2;
        const domainRaise = near && (f.raises || []).some((x) => inRange(x.line, b.then) && classBases[x.type] && !STDLIB_PARENTS[x.type] && handled.has(x.type));
        if (ends > 0) set('decision', 'ending-in-arm'); else if (domainRaise) set('decision', 'refusal-check'); else if (depth[id] === 0 && brs.length <= 8 && t.calls > 0) set('decision', 'front-door-path'); else set('guard', 'early-exit');
      } else if (ends > 0) set('decision', 'ending-in-arm');
      else if (callArms >= 2) set('decision', 'two-paths');
      else if (hints > 0) set('guard', 'retry-handled');
      else if (!hasElse && t.size <= 2) set('trivial', 'tiny-arm');
      else if (calls > 0 || loops > 0 || raises > 0) set('guard', 'work-in-arm'); else set('trivial', 'local-only');
      rows.push({ b, w, rule, switch: rule === 'switch-test' ? sw : null, chain: chain.length > 1 ? chain.length : 0 });
    }
    for (const r of rows) {
      const { b } = r;
      branches.push({ id: `branch:${id}:${n++}`, fn: id, line: b.line, test: b.test, weight: r.w, kind: b.kind, rule: r.rule, ...(r.switch ? { switch: r.switch } : {}), ...(r.chain ? { arms: r.chain } : {}), ...(r.head ? { head: r.head } : {}) });
    }
  }

  // the same switch tested again in the same module is the same gate: the first stays a decision, the rest are guards that point at it
  const firstGate = new Map();
  for (const b of branches) {
    if (b.rule !== 'switch-test') continue;
    const key = b.switch + '|' + b.fn.slice(0, b.fn.indexOf('::'));
    if (!firstGate.has(key)) { firstGate.set(key, b); continue; }
    b.weight = 'guard'; b.rule = 'same-switch'; b.head = firstGate.get(key).line;
  }

  // ---- passes --------------------------------------------------------------------------------------
  const passes = [];
  for (const id of ids) {
    const f = fns[id], rows = [];
    const hints = f.retryHints || [], usedHints = new Set();
    for (const l of f.loops || []) {
      const inside = hints.filter((h) => h.line >= l.line && h.line <= (l.end || l.line));
      inside.forEach((h) => usedHints.add(h));
      if (l.kind === 'recursion') { rows.push({ line: l.line, kind: 'recursion', bounded: !!l.bounded, why: l.why }); continue; }
      const sleeps = inside.some((h) => /sleep call/i.test(h.why));
      const handlers = (f.excepts || []).some((x) => x.line >= l.line && x.line <= (l.end || l.line));
      const retryish = inside.some((h) => /counter|counts tries|backoff|retry|decorated/i.test(h.why)) || (sleeps && handlers);
      if (l.kind === 'for' && l.bounded && !inside.some((h) => !/(?:except|catch) clause then continue/.test(h.why))) continue;
      rows.push({ line: l.line, kind: retryish ? 'retry' : 'loop', bounded: !!l.bounded, why: l.why, ...(l.test ? { test: l.test } : {}), end: l.end });
    }
    for (const h of hints) if (!usedHints.has(h)) rows.push({ line: h.line, kind: 'retry', bounded: true, why: h.why });
    rows.sort((a, b) => a.line - b.line || cmp(a.kind, b.kind));
    rows.forEach((r, i) => passes.push({ id: `pass:${id}:${i}`, fn: id, line: r.line, kind: r.kind, bounded: r.bounded, members: [], why: r.why, ...(r.test ? { test: r.test } : {}) }));
  }
  for (const s of graph.scc || []) {
    const first = s.fns[0], f = fns[first];
    const mine = passes.filter((p) => p.fn === first).length;
    passes.push({ id: `pass:${first}:${mine}`, fn: first, line: f ? f.line : 0, kind: 'scc', bounded: false, members: s.fns.slice(0, 12), why: `${s.fns.length} functions call each other in a cycle` });
  }

  // ---- switches ------------------------------------------------------------------------------------
  const byName = new Map();
  for (const s of facts.switches.slice().sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.name, b.name))) {
    if (s.kind === 'env' && OS_ENV.has(s.name.toUpperCase())) continue;
    if (!byName.has(s.name)) byName.set(s.name, { ...s, reads: 0 });
    const cur = byName.get(s.name); cur.reads++;
    if (cur.default == null && s.default != null) cur.default = s.default;
    if (!cur.cmp && s.cmp) cur.cmp = s.cmp;
  }
  const KNOB = /enable|disable|allow|auto|limit|max|min|timeout|retry|retries|attempt|interval|cooldown|threshold|keep|mode|backend|provider|ttl|cap|batch|budget|delay|backoff|concurren|duration|lock|stall|drain|rate|size|offline|debug|dry_run|feature|flag|experimental|beta/i;
  const switches = [...byName.values()].filter((s) => s.kind !== 'config' || /^(?:true|false)$/i.test(String(s.default).trim()) || KNOB.test(s.name)).sort((a, b) => cmp(a.name, b.name)).map((s) => {
    const d = (s.default == null ? '' : String(s.default)).trim().toLowerCase();
    const boolDefault = /^(?:true|false)$/.test(d);
    const toggle = TOGGLE_NAME.test(s.name) || boolDefault || (s.cmp && TRUTHY_CMP.test(s.cmp)) || s.cast === 'bool' || s.cast === 'Boolean';
    return { id: `switch:${s.name}`, path: s.path, line: s.line, default: s.default == null ? null : String(s.default), offByDefault: !!(toggle && FALSY.has(d)), kind: s.kind, reads: s.reads };
  });

  let rawReturns = 0;
  for (const id of ids) rawReturns += (fns[id].returns || []).length + (fns[id].raises || []).length;
  const counts = { endings: endings.length, branches: branches.length, passes: passes.length, switches: switches.length, rawReturnsAndRaises: rawReturns,
    endingsRequired: endings.filter((e) => e.confidence !== 'low').length, decisionBranches: branches.filter((b) => b.weight === 'decision').length,
    guardBranches: branches.filter((b) => b.weight === 'guard').length, trivialBranches: branches.filter((b) => b.weight === 'trivial').length,
    outcomeTypes: outcomeTypes.length, droppedLowEndings: droppedLow };
  return { schema: 'faultline.census/1', outcomeTypes, endings, branches, passes, switches, counts };
}
