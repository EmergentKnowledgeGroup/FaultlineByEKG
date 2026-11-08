// The outside triggers a journey can start from: HTTP route arms, event handlers, timers and threads, command-line mains,
// and exported API with no caller in the code. Anything else with no caller is listed as "uncalled" (its trigger is not known).
import { cmp, uniq } from './util.mjs';
import { routeOfDecorator, routeOfRegistration } from './routes.mjs';

const EVENT_CALLS = new Set(['addEventListener', 'on', 'once', 'addListener', 'subscribe', 'listen']);
const TIMER_CALLS = new Set(['setInterval', 'setTimeout', 'setImmediate', 'requestAnimationFrame', 'Timer', 'call_later', 'call_soon', 'schedule', 'every']);
const THREAD_CALLS = new Set(['Thread', 'create_task', 'add_done_callback']);

/** Priority of a trigger kind when journeys are ranked: what a reader most wants a story for. */
export const TRIGGER_WEIGHT = { route: 6, main: 5, export: 4, event: 3, background: 2, timer: 2 };

/** A file that starts from the command line says so: a `__main__` guard, an argument parser, or the process arguments. */
const COMMAND_LINE = /__name__\s*==\s*["']__main__["']|\bargparse\b|\bsys\.argv\b|\bclick\.|\btyper\.|\brequire\.main\s*===?\s*module|\bprocess\.argv\b/;

const clipText = (t) => (t.length > 28 ? `${t.slice(0, 27)}\u2026` : t);
const lit = (text) => {
  const m = /^(["'`])([^"'`]*)\1$/.exec((text ?? '').trim());
  return m ? m[2] : '';
};

/**
 * Find every trigger of the system.
 * @returns {{triggers: object[], uncalled: string[]}}
 */
export function findTriggers(W, CM, names, words) {
  const triggers = [];
  const seenLabel = new Set();
  const add = (t) => {
    const key = `${t.kind}|${t.label}|${t.fid}|${t.lambda ?? ''}`;
    if (seenLabel.has(key)) return;
    seenLabel.add(key);
    triggers.push(t);
  };

  // scanner call graph: who is called by someone
  const calledByFacts = new Set();
  for (const ff of CM.factsFns.values()) for (const c of ff.calls ?? []) calledByFacts.add(c);
  const hasCaller = (fid) => (W.callersOf.get(fid) ?? []).some((r) => W.fnOf(r.from) !== fid) || calledByFacts.has(fid);
  // functions handed to another call (they run through that call, so they are not triggers themselves)
  const passedTo = new Set();
  for (const fid of W.fnIds) {
    const f = W.fns.get(fid);
    if (!f.mapped && !CM.factsOf(fid)) continue;
    const u = CM.unit(fid);
    for (const s of u.sites) for (const a of s.fnArgs ?? []) {
      if (a.kind === 'lambda') {
        const m = CM.mappedLambda(fid, a);
        if (m) passedTo.add(m);
      } else {
        const r = CM.resolveRef(fid, a.text);
        if (r) passedTo.add(r);
      }
    }
  }

  // 1. route arms
  for (const fid of W.mappedIds) {
    const f = W.fns.get(fid);
    for (const b of f.boxes) {
      const w = words.get(b.id);
      if (w?.route) add({ kind: 'route', label: w.route.label, fid, startBox: b.id, forceThen: true, line: b.prov.line, detail: `a request for ${w.route.label}`, prefix: w.route.prefix });
    }
  }

  // 2. functions registered with an event, timer, thread or route call
  for (const fid of W.fnIds) {
    const f = W.fns.get(fid);
    if (!f.mapped && !CM.factsOf(fid)) continue;
    const u = CM.unit(fid);
    for (const ex of u.externals ?? []) {
      const evName = lit(ex.args[0]?.text);
      const route = routeOfRegistration(ex.name, ex.args[0]?.text);
      for (const a of ex.args) {
        if (!a.kind) continue;
        let target = null;
        if (a.kind === 'lambda') {
          const m = CM.mappedLambda(fid, a);
          const li = u.lambdas.findIndex((L) => L.arg.start === a.start);
          target = m ? { fid: m } : li >= 0 ? { fid, lambda: li } : null;
        } else {
          const r = CM.resolveRef(fid, a.text);
          if (r) target = { fid: r };
        }
        if (!target) continue;
        const holder = names.label(fid);
        let kind;
        let label;
        let detail;
        if (route) {
          kind = 'route';
          label = route.label;
          detail = `a request for ${route.label}`;
        } else if (EVENT_CALLS.has(ex.name)) {
          kind = 'event';
          label = `${evName ? `"${evName}" event` : 'event'} on ${ex.recvText ? clipText(ex.recvText) : 'an element'}`;
          detail = `the ${evName ? `"${evName}" ` : ''}event on ${ex.recvText ? clipText(ex.recvText) : 'an element'}, registered in ${holder}`;
        } else if (TIMER_CALLS.has(ex.name)) {
          kind = 'timer';
          label = `timer (${ex.name})`;
          detail = `a timer set in ${holder}`;
        } else if (THREAD_CALLS.has(ex.name)) {
          kind = 'background';
          label = `background task (${ex.name})`;
          detail = `a thread or task started in ${holder}`;
        } else continue;
        add({ kind, label, fid: target.fid, lambda: target.lambda, line: ex.line, holder: fid, detail });
      }
    }
  }

  // 3. decorators (facts)
  for (const fid of CM.factsFns.keys()) {
    const ff = CM.factsFns.get(fid);
    for (const d of ff.decorators ?? []) {
      const route = routeOfDecorator(d);
      if (route && W.fns.has(fid)) add({ kind: 'route', label: route.label, fid, line: ff.line, detail: `a request for ${route.label}` });
      else if (/\.(event|listener|command|on|task|loop)\b/.test(d) && W.fns.has(fid)) add({ kind: 'event', label: `${d.replace(/^@/, '').replace(/\(.*$/, '')} handler`, fid, line: ff.line, detail: `registered with ${d}` });
    }
  }

  // 4. entries the scanner found
  for (const e of W.facts?.entries ?? []) {
    if (!W.fns.has(e.fn)) continue;
    if (e.kind === 'main' && /__name__|require\.main|main module/.test(e.why)) add({ kind: 'main', label: `command line: ${names.label(e.fn)}`, fid: e.fn, line: W.fns.get(e.fn).line, detail: 'running the program from the command line' });
    else if (e.kind === 'worker' && /thread|timer/.test(e.why)) add({ kind: /timer/.test(e.why) ? 'timer' : 'background', label: `${/timer/.test(e.why) ? 'timer' : 'background task'}: ${names.label(e.fn)}`, fid: e.fn, line: W.fns.get(e.fn).line, detail: e.why });
    else if (e.kind === 'export' && !hasCaller(e.fn) && !passedTo.has(e.fn)) add({ kind: 'export', label: names.label(e.fn), fid: e.fn, line: W.fns.get(e.fn).line, detail: `a call from outside: ${e.why}` });
    else if (e.kind === 'route' && !triggers.some((t) => t.kind === 'route' && t.fid === e.fn)) add({ kind: 'route', label: `${/(GET|POST|PUT|DELETE|PATCH)/.exec(e.why)?.[1] ?? 'HTTP'} handler ${names.label(e.fn)}`, fid: e.fn, line: W.fns.get(e.fn).line, detail: e.why });
  }

  // 5. without scanner facts: exported declarations and mains by name
  if (!W.facts) {
    for (const fid of W.mappedIds) {
      const f = W.fns.get(fid);
      if (f.anon || hasCaller(fid) || passedTo.has(fid)) continue;
      const decl = W.source.line(f.path, f.line);
      const last = f.qual.split('.').pop();
      const segs = f.qual.split('.');
      const isMethod = segs.length === 2 && /^[A-Z]/.test(segs[0]) && !segs[1].startsWith('_') && !segs[1].startsWith('#') && segs[1] !== 'constructor';
      if (f.lang === 'ts' && /^\s*export\b/.test(decl)) add({ kind: 'export', label: names.label(fid), fid, line: f.line, detail: 'exported, with no caller in the code' });
      else if (f.lang === 'ts' && isMethod && !/\b(private|protected)\b/.test(decl)) {
        const cl = W.source.classLine(f.path, segs[0]);
        if (cl && /^\s*export\b/.test(W.source.line(f.path, cl))) add({ kind: 'export', label: names.label(fid), fid, line: f.line, detail: 'public method of an exported class, with no caller in the code' });
      } else if (f.lang === 'py' && isMethod && !segs[0].startsWith('_')) add({ kind: 'export', label: names.label(fid), fid, line: f.line, detail: 'public method with no caller in the code' });
      else if (f.lang === 'py' && !f.parent && !last.startsWith('_') && last !== '<module>') {
        // a function is a command-line start only when its file says so; a name is not enough
        const cli = last === 'main' && COMMAND_LINE.test(W.source.file(f.path)?.text ?? '');
        add({ kind: cli ? 'main' : 'export', label: cli ? `command line: ${names.label(fid)}` : names.label(fid), fid, line: f.line, detail: cli ? 'running the program from the command line' : 'public function with no caller in the code' });
      }
    }
  }

  const triggerFids = new Set(triggers.map((t) => t.fid));
  const uncalled = W.mappedIds.filter((fid) => {
    const f = W.fns.get(fid);
    return !f.anon && !hasCaller(fid) && !passedTo.has(fid) && !triggerFids.has(fid) && f.qual !== '<module>';
  });
  triggers.sort((a, b) => (TRIGGER_WEIGHT[b.kind] ?? 0) - (TRIGGER_WEIGHT[a.kind] ?? 0) || cmp(a.fid, b.fid) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.label, b.label));
  return { triggers, uncalled: uniq(uncalled).sort(cmp), hasCaller, passedTo };
}
