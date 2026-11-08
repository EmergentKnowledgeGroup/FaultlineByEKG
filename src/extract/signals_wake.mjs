// lostWakeup rows (pure: raw per-function facts in, rows out). For a stop/start pair of a class:
//   a field F that both sides assign, the start side putting it back;
//   a loop in another method of the same class that reads F in its condition or a guard, and can park (an await or a blocking call that is not a plain sleep);
//   the start side, on EVERY path, calls that method (or something that always calls it) or does something wake-like.
// When some path does neither, the row is kept. A loop whose only blocking calls are sleeps with a time re-checks F by itself: the row says `polls: true`
// and the check does not report it. Facts come from signals_ts_wake.mjs and signals_py_wake.py: see the skeleton node shapes there.

// Walk a skeleton. ev: has a wake already happened on this path. -> {fall: true|false|null, bad}. fall is the state where the path falls off the end
// (null when every path returns first); bad is true when some return leaves with no wake.
function walk(seq, ev, isEv) {
  let bad = false;
  for (const x of seq || []) {
    if (x.t === 'c' || x.t === 'w') { if (isEv(x)) ev = true; }
    else if (x.t === 'r') return { fall: null, bad: bad || !ev };
    else if (x.t === 'x') return { fall: null, bad };
    else if (x.t === 'if') {
      const a = walk(x.a, ev, isEv), b = walk(x.b, ev, isEv);
      bad = bad || a.bad || b.bad;
      const falls = [a.fall, b.fall].filter((f) => f !== null);
      if (!falls.length) return { fall: null, bad };
      ev = falls.every(Boolean);
    } else if (x.t === 'l') { const r = walk(x.b, ev, isEv); bad = bad || r.bad; }           // a loop body may run zero times
    else if (x.t === 't') {
      const b = walk(x.b, ev, isEv), cs = (x.c || []).map((c) => walk(c, ev, isEv));
      bad = bad || b.bad || cs.some((c) => c.bad);
      const falls = [b.fall, ...cs.map((c) => c.fall)].filter((f) => f !== null);
      if (!falls.length) return { fall: null, bad };
      ev = falls.every(Boolean);
      if (x.f && x.f.length) { const f = walk(x.f, ev, isEv); bad = bad || f.bad; if (f.fall === true) ev = true; }
    } else if (x.t === 's') {
      const rs = (x.cs || []).map((c) => walk(c, ev, isEv));
      bad = bad || rs.some((r) => r.bad);
      const falls = rs.map((r) => r.fall).filter((f) => f !== null);
      if (x.d && !falls.length) return { fall: null, bad };
      ev = falls.every(Boolean) && (x.d || ev);
    }
  }
  return { fall: ev, bad };
}
const alwaysOk = (r) => !r.bad && r.fall !== false;

// Every call to this.method() in a skeleton, anywhere in it
function callsIn(seq, out = []) {
  for (const x of seq || []) {
    if (x.t === 'c') out.push(x);
    else if (x.t === 'if') { callsIn(x.a, out); callsIn(x.b, out); }
    else if (x.t === 'l') callsIn(x.b, out);
    else if (x.t === 't') { callsIn(x.b, out); (x.c || []).forEach((c) => callsIn(c, out)); callsIn(x.f, out); }
    else if (x.t === 's') (x.cs || []).forEach((c) => callsIn(c, out));
  }
  return out;
}
function wakesIn(seq, out = []) {
  for (const x of seq || []) {
    if (x.t === 'w') out.push(x);
    else if (x.t === 'if') { wakesIn(x.a, out); wakesIn(x.b, out); }
    else if (x.t === 'l') wakesIn(x.b, out);
    else if (x.t === 't') { wakesIn(x.b, out); (x.c || []).forEach((c) => wakesIn(c, out)); wakesIn(x.f, out); }
    else if (x.t === 's') (x.cs || []).forEach((c) => wakesIn(c, out));
  }
  return out;
}

export function lostWakeups({ pairs, fieldWrites, groups, byId, classes }) {
  const rows = [];
  for (const p of pairs) {
    if (!p.ownerIsClass) continue;
    const fw = fieldWrites[p.id], a = byId.get(p.stop.fn), b = byId.get(p.start.fn);
    if (!fw || !a || !b) continue;
    const owners = groups.get(`${p.path}::${p.owner}`) || [];
    const byName = new Map();
    for (const m of owners) if (!byName.has(m.name)) byName.set(m.name, m);
    const cls = classes.get(`${p.path}::${p.owner}`);
    // fields both sides assign, with different literal values (the start side puts it back)
    const fields = [];
    for (const r of fw.start) {
      const s = fw.stop.find((x) => x.field === r.field);
      if (s && s.value !== null && r.value !== null && s.value !== r.value && !fields.some((f) => f.field === r.field)) fields.push({ field: r.field, stop: s, start: r });
    }
    // names a loop might read that stand for F: the field itself, or a one-line getter/method that returns it (two hops)
    const standsFor = (name, depth = 0) => {
      const set = new Set([name]);
      const m = byName.get(name);
      if (m && m.gt && depth < 2) for (const g of m.gt) for (const x of standsFor(g, depth + 1)) set.add(x);
      return set;
    };
    for (const F of fields) {
      for (const m of owners) {
        if (m.id === a.id || m.id === b.id || !m.lp) continue;
        let hit = null, loop = null;
        for (const L of m.lp) { const h = L.reads.find((r) => standsFor(r.name).has(F.field)); if (h) { hit = h; loop = L; break; } }
        if (!loop) continue;
        const polls = loop.blocks.every((x) => x.timed);
        const waits = loop.blocks.map((x) => x.recv).filter(Boolean);
        const isWake = (x) => (x.n === 'add' || x.n === 'put') ? !!x.r && waits.includes(x.r) : true;
        const memo = new Map(), stack = new Set();
        const reaches = (name) => {
          if (memo.has(name)) return memo.get(name);
          const f = byName.get(name);
          if (!f || stack.has(name)) return false;
          stack.add(name);
          const ok = alwaysOk(walk(f.sk, false, isEv));
          stack.delete(name);
          memo.set(name, ok);
          return ok;
        };
        const isEv = (x) => x.t === 'w' ? isWake(x) : x.n === m.name || reaches(x.n);
        // a call that reaches the loop's method on SOME path (a few hops through this class's own methods): the start side does call it, just not always
        const may = (name, depth = 0, seen = new Set()) => {
          if (name === m.name) return true;
          const f = byName.get(name);
          if (!f || depth > 3 || seen.has(name)) return false;
          seen.add(name);
          return callsIn(f.sk).some((c) => may(c.n, depth + 1, seen));
        };
        if (alwaysOk(walk(b.sk, false, isEv))) continue;                    // every path of the start side wakes it
        const calls = callsIn(b.sk).filter((c) => may(c.n)).map((c) => ({ name: c.n, line: c.l }));
        const wakes = wakesIn(b.sk).filter(isWake).map((w) => ({ name: w.n, recv: w.r, line: w.l }));
        const open = (b.supers > 0 || callsIn(b.sk).some((c) => !byName.has(c.n))) && !!cls && cls.bases > 0;
        rows.push({
          pair: p.id, family: p.family, path: p.path, owner: p.owner, field: F.field,
          stop: { fn: a.id, name: a.name, line: a.line, setAt: F.stop.line, setIn: F.stop.fn, value: F.stop.value },
          start: { fn: b.id, name: b.name, line: b.line, restoreAt: F.start.line, restoreIn: F.start.fn, value: F.start.value },
          loop: { fn: m.id, name: m.name, line: loop.line, end: loop.end, kind: loop.kind, readAt: hit.line, how: hit.how, via: hit.name !== F.field ? hit.name : '' },
          blocks: loop.blocks.slice(0, 4).map((x) => ({ kind: x.kind, name: x.name, recv: x.recv, line: x.line, timed: !!x.timed })),
          polls, startCalls: calls.slice(0, 4), startWakes: wakes.slice(0, 4), startOpen: open,
        });
      }
    }
  }
  return rows;
}
