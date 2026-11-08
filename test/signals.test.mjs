// Tests for signals.json (pairs, sticky flags, lost wakeups, never-sent names, empty handlers, swallowed errors) and the checks that read it, plus
// the shared-decision rule, leads, kept-suspect slots, orphan dismissals and the small gate fixes.
// Small invented fixtures in TypeScript and Python, each signal with a case that must fire and a case that must not.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSignals, signalsFromRaw } from '../src/extract/signals.mjs';
import { familyOf } from '../src/extract/signals_words.mjs';
import { fileURLToPath } from 'node:url';
import { analyze, CHECKS, hasBannedWord, validateModel } from '../src/model/index.mjs';
import { SWITCH_NOTE } from '../src/model/gates.mjs';
import { breaks } from '../src/agent/commands.mjs';

let dir, sig;
const TS = `
enum Verb { Open = 'open', Shut = 'shut', Nudge = 'nudge', Wave = 'wave' }
enum Level { Low, High }
enum Spread { A = 'aa1', B = 'bb2', C = 'cc3' }
class Gate { stop() {} }
export class Kettle extends Gate {
  private cooling = false;
  private sealed = false;
  private banner = false;
  private quiet = false;
  private plain = false;
  pause() { this.cooling = true; this.sealed = true; this.banner = true; this.plain = true; }
  resume() { this.cooling = false; this.tick(); }
  tick() { if (this.sealed) return; if (this.banner) this.emit(); }
  emit() {}
  check() { if (this.plain) return 1; }
  pauseLine() { this.quiet = true; }
  resumeLine() { if (this.quiet) return; }
  close() {}
  onData() {}
  sweep() { for (const x of []) { x(); } }
}
export class Latch {
  private done = false;
  end() { this.done = true; }
  begin() { this.reset(); }
  reset() { this.done = false; }
  look() { if (this.done) return; }
}
export class Lonely { stop() {} }
export class NoParent { close() {} }
function pauseJob() {} function resumeJob() {} function startOnly() {}
function handle(v: Verb, l: Level, s: Spread) {
  switch (v) {
    case Verb.Open: send(Verb.Open); break;
    case Verb.Shut: break;
    case Verb.Nudge: case Verb.Wave: act(); break;
    default: break;
  }
  if (l === Level.High) act();
  if (s === Spread.A) act();
  const all = Object.values(Spread);
  try { risky(); } catch (e) {}
  try { risky(); } catch (e) { console.error(e); }
  try { risky(); } catch (e) { throw e; }
  try { risky(); } catch (e) { report(e); }
  try { risky(); } catch { /* ignore */ }
  try { await conn.close(); } catch {}
  try { const z = require('zz'); } catch {}
  risky().catch(() => {});
  const p = risky();
  p.catch(() => {});
  emitter.on('error', () => {});
  emitter.on('data', () => act());
}
`;
const PY = `
import enum, threading, logging
class Cmd(enum.Enum):
    HELLO = "hello"
    BYE = "bye"
    PING = "ping"
    GONE = "gone"
class Pump(Base):
    def __init__(self):
        self.stopping = False
        self._ev = threading.Event()
        self._ev2 = threading.Event()
        self.count = 0
    def stop(self):
        self.stopping = True
        self._ev.set()
        self._ev2.set()
        self.count = 0
    def start(self):
        self._ev2.clear()
        self.run()
    def run(self):
        while not self._ev.is_set():
            if self.stopping:
                break
    def close(self):
        pass
    def on_message(self, m):
        if m == Cmd.HELLO:
            send(Cmd.HELLO)
        elif m == Cmd.BYE:
            pass
    def route(self, m):
        match m:
            case Cmd.PING:
                pass
            case Cmd.GONE:
                self.stop()
class Plain:
    def close(self):
        pass
    def pause_x(self): pass
    def resume_y(self): pass
def _stop_job(): pass
def _start_job(): pass
def go():
    try:
        x = 1
    except Exception:
        pass
    try:
        x = 1
    except KeyError:
        pass
    try:
        x = 1
    except Exception as e:
        logging.error(e)
    try:
        x = 1
    except Exception:
        raise
    try:
        x = 1
    except:
        pass
    for i in range(3):
        try:
            x = 1
        except Exception:
            break
`;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-signals-'));
  fs.writeFileSync(path.join(dir, 'kettle.ts'), TS);
  fs.writeFileSync(path.join(dir, 'pump.py'), PY);
  sig = await buildSignals(dir, [{ path: 'kettle.ts', lang: 'ts' }, { path: 'pump.py', lang: 'py' }]);
});
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
const names = (rows) => rows.map((r) => r.name || r.field).sort();
const pairNames = (lang) => sig.pairs.filter((p) => p.path.endsWith(lang)).map((p) => `${p.stop.name}/${p.start.name}`).sort();

test('familyOf: words, prefixes and suffixes; whole words only', () => {
  assert.deepEqual(familyOf('pauseWorker').map((m) => [m.family, m.side, m.stem]), [['pause/resume', 'stop', '* worker']]);
  assert.deepEqual(familyOf('_start_x').map((m) => [m.side, m.stem]), [['start', '* x']]);
  assert.deepEqual(familyOf('restart'), [], 'restart is not start');
  assert.deepEqual(familyOf('isClosed'), [], 'closed is not close');
});

test('pairs: same class or module, opposite words, same stem', () => {
  assert.deepEqual(pairNames('.ts'), ['end/begin', 'pause/resume', 'pauseJob/resumeJob', 'pauseLine/resumeLine'], 'Kettle pause/resume, Kettle pauseLine/resumeLine, Latch end/begin, module pauseJob/resumeJob');
  assert.ok(!sig.pairs.some((p) => p.stop.name === 'stop' && p.path.endsWith('.ts')), 'a stop with no start pairs with nothing');
  assert.ok(!pairNames('.ts').includes('startOnly'));
  assert.deepEqual(pairNames('.py'), ['_stop_job/_start_job', 'stop/start'], 'Pump stop/start and the module pair; pause_x / resume_y share no stem');
  const k = sig.pairs.find((p) => p.stop.fn === 'kettle.ts::Kettle.pause');
  assert.equal(k.ownerIsClass, true);
  assert.equal(k.stop.line > 0 && k.start.line > k.stop.line, true);
  assert.equal(sig.pairs.find((p) => p.stop.name === 'pauseJob').ownerIsClass, false);
});

test('fieldWrites: what each side assigns, with the literal value', () => {
  const k = sig.pairs.find((p) => p.stop.fn === 'kettle.ts::Kettle.pause');
  const w = sig.fieldWrites[k.id];
  assert.deepEqual(w.stop.map((x) => [x.field, x.value]), [['cooling', 'true'], ['sealed', 'true'], ['banner', 'true'], ['plain', 'true']]);
  assert.deepEqual(w.start.map((x) => [x.field, x.value]), [['cooling', 'false']]);
  const p = sig.pairs.find((x) => x.stop.fn === 'pump.py::Pump.stop');
  assert.deepEqual(sig.fieldWrites[p.id].stop.map((x) => [x.field, x.value]), [['stopping', 'true'], ['_ev', 'set()'], ['_ev2', 'set()'], ['count', '0']]);
});

test('sticky: set on the way down, never cleared on the way back up, and read in a condition', () => {
  const ts = sig.sticky.filter((s) => s.path === 'kettle.ts');
  assert.deepEqual(ts.map((s) => s.field).sort(), ['banner', 'plain', 'sealed'], 'cooling is cleared by resume; quiet is read by the start function itself');
  assert.ok(ts.every((s) => s.stop.name === 'pause' && s.value === 'true'));
  assert.ok(ts.find((s) => s.field === 'sealed').reads.some((r) => r.name === 'tick'), 'a helper the start side calls reads it');
  assert.ok(ts.find((s) => s.field === 'plain').reads.some((r) => r.name === 'check'));
  assert.equal(sig.sticky.filter((s) => s.path === 'kettle.ts' && s.owner === 'Latch').length, 0, 'Latch.begin clears done through reset()');
  const py = sig.sticky.filter((s) => s.path === 'pump.py');
  assert.deepEqual(py.map((s) => s.field).sort(), ['_ev', 'stopping'], '_ev2 is cleared by start; count = 0 is only emptying');
  assert.equal(py.find((s) => s.field === '_ev').value, 'set()');
});

test('neverSent: only handled, never assigned, passed or sent; plain-number enums and enums used dynamically are left alone', () => {
  const n = sig.neverSent;
  assert.deepEqual(n.filter((x) => x.path === 'kettle.ts').map((x) => x.name).sort(), ['Verb.Nudge', 'Verb.Shut', 'Verb.Wave']);
  assert.equal(n.find((x) => x.name === 'Verb.Shut').handlerEmpty, true, 'case Shut: break');
  assert.equal(n.find((x) => x.name === 'Verb.Nudge').handlerEmpty, false);
  assert.ok(!n.some((x) => x.name === 'Verb.Open'), 'sent by send(Verb.Open)');
  assert.ok(!n.some((x) => /^Level\./.test(x.name)), 'plain numbers come from outside');
  assert.ok(!n.some((x) => /^Spread\./.test(x.name)), 'Object.values(Spread) can send any of them');
  assert.deepEqual(n.filter((x) => x.path === 'pump.py').map((x) => x.name).sort(), ['Cmd.BYE', 'Cmd.GONE', 'Cmd.PING']);
  assert.equal(n.find((x) => x.name === 'Cmd.BYE').handlerEmpty, true);
  assert.equal(n.find((x) => x.name === 'Cmd.PING').handlerEmpty, true, 'match case with pass');
  assert.equal(n.find((x) => x.name === 'Cmd.GONE').handlerEmpty, false);
  assert.ok(!n.some((x) => x.name === 'Cmd.HELLO'), 'send(Cmd.HELLO)');
});

test('neverSent: a name sent as a plain string in another language is not reported', async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-signals2-'));
  try {
    fs.writeFileSync(path.join(d2, 'client.ts'), "enum Mode { Idle = 'idle', Busy = 'busy' }\nfunction f(m: Mode) { switch (m) { case Mode.Idle: break; case Mode.Busy: break; } }\n");
    fs.writeFileSync(path.join(d2, 'server.py'), "def send():\n    return {'mode': 'busy'}\n");
    const s = await buildSignals(d2, [{ path: 'client.ts', lang: 'ts' }, { path: 'server.py', lang: 'py' }]);
    assert.deepEqual(s.neverSent.map((x) => x.name), ['Mode.Idle'], 'Busy is sent by the server');
  } finally { fs.rmSync(d2, { recursive: true, force: true }); }
});

test('emptyHandlers: empty cases, empty event handlers, empty lifecycle methods on a class with a parent', () => {
  const h = sig.emptyHandlers;
  const ts = h.filter((x) => x.path === 'kettle.ts');
  assert.deepEqual(ts.filter((x) => x.kind === 'case').map((x) => x.label), ['Verb.Shut'], 'a case that falls through to a body is not empty; default is left alone');
  assert.deepEqual(ts.filter((x) => x.kind === 'lifecycle').map((x) => x.fn), ['kettle.ts::Kettle.close'], 'NoParent.close has no parent; Lonely.stop has none either');
  assert.deepEqual(ts.filter((x) => x.kind === 'handler').map((x) => x.name).sort(), ['on(error)', 'onData']);
  const py = h.filter((x) => x.path === 'pump.py');
  assert.deepEqual(py.filter((x) => x.kind === 'lifecycle').map((x) => x.fn), ['pump.py::Pump.close'], 'Plain.close has no base class');
  assert.deepEqual(py.filter((x) => x.kind === 'case').map((x) => x.label).sort(), ['Cmd.PING', 'm == Cmd.BYE']);
  assert.ok(py.some((x) => x.kind === 'handler' && x.name === 'on_message') === false, 'on_message has a body');
});

test('swallowed: no rethrow, no log, no use of the error; narrow, cleanup and break-only are marked', () => {
  const ts = sig.swallowed.filter((x) => x.path === 'kettle.ts');
  assert.deepEqual(ts.map((x) => [x.kind, x.empty, !!x.comment, x.cleanup]).sort(), [['catch', true, false, false], ['catch', true, false, true], ['catch', true, false, true], ['catch', true, true, false], ['promise-catch', true, false, false]].sort(),
    'catch {} / only a comment / a lone close() call or an optional require / .catch(() => {}) on a call; logged, rethrown, reported or used errors and p.catch on a held promise are not swallowed');
  const py = sig.swallowed.filter((x) => x.path === 'pump.py');
  assert.equal(py.length, 4);
  assert.deepEqual(py.map((x) => [x.broad, x.only]).sort(), [[false, 'pass'], [true, 'break'], [true, 'pass'], [true, 'pass']].sort());
});

// ---- the checks ---------------------------------------------------------------------------------------------------------------------
const box = (id, o = {}) => ({ id, stage: 's1', kind: 'step', title: id, plain: `${id} does its thing`, status: 'live', refs: [], ...o });
const cites = (p, qual, line = 5) => ({ path: p, symbol: `${p}::${qual}`, line });
const route = (id, from, to, when = 'If ok', o = {}) => ({ id, from, to, type: 'forward', when, why: '', refs: [], inferred: false, ...o });
const mk = (boxes, routes, extra = {}) => ({ schema: 'faultline.model/1', system: { name: 'mini' }, stages: [{ id: 's1', title: 'One', order: 1 }, { id: 's2', title: 'Two', order: 2 }, { id: 's3', title: 'Three', order: 3 }, { id: 's4', title: 'Four', order: 4 }], boxes, routes, loops: [], paths: [], charts: [], terms: [], ledger: {}, modules: {}, ...extra });
const run = (m, signals = null, dismissed = {}) => analyze(m, null, null, null, { signals, dismissed });
const only = (f, c) => f.filter((x) => x.check === c);
const PAIR = { id: 'k.ts::K|pause/resume|*', path: 'k.ts', owner: 'K', family: 'pause/resume', stem: '*', ownerIsClass: true, stop: { fn: 'k.ts::K.pause', name: 'pause', line: 5, end: 9 }, start: { fn: 'k.ts::K.resume', name: 'resume', line: 11, end: 15 } };

test('restart-misses: the stop side reaches a wait the start side cannot get back to', () => {
  const m = mk([box('pause.go', { refs: [cites('k.ts', 'K.pause')] }), box('park', { kind: 'wait' }), box('after', { kind: 'end' }), box('resume.go', { refs: [cites('k.ts', 'K.resume')] }), box('run')],
    [route('r1', 'pause.go', 'park'), route('r2', 'park', 'after', 'If woken'), route('r3', 'resume.go', 'run')]);
  const f = only(run(m, { pairs: [PAIR] }), 'restart-misses');
  assert.equal(f.length, 1);
  assert.match(f[0].question, /`pause` reaches park; `resume` doesn't reach it\. What wakes it after a resume\?/);
  assert.deepEqual(f[0].boxes.slice(0, 3), ['pause.go', 'resume.go', 'park']);
  // a road from the start side to the wait removes it; so does a stop box that leads straight to the start box with no wait between (a switch drawn as a chain)
  const fixed = mk(m.boxes, [...m.routes, route('r4', 'run', 'park')]);
  assert.equal(only(run(fixed, { pairs: [PAIR] }), 'restart-misses').length, 0);
  const sw = mk(m.boxes, [...m.routes, route('r5', 'pause.go', 'resume.go')]);
  assert.equal(only(run(sw, { pairs: [PAIR] }), 'restart-misses').length, 0);
  assert.equal(only(run(m, null), 'restart-misses').length, 0, 'without signals the check does not run');
});

test('restart-misses: a loop the stop side enters and the start side cannot enter', () => {
  const m = mk([box('pause.go', { refs: [cites('k.ts', 'K.pause')] }), box('l.a'), box('l.b'), box('resume.go', { refs: [cites('k.ts', 'K.resume')] }), box('run')],
    [route('r1', 'pause.go', 'l.a'), route('r2', 'l.a', 'l.b'), route('r3', 'l.b', 'l.a', 'If again', { type: 'return' }), route('r4', 'resume.go', 'run')], { loops: [{ id: 'lp', title: 'Poll', boxes: ['l.a', 'l.b'], limit: '' }] });
  const f = only(run(m, { pairs: [PAIR] }), 'restart-misses');
  assert.equal(f.length, 1);
  assert.match(f[0].question, /l\.a, the entry of a loop/);
});

test('sticky-flag: a candidate with a question; on no box it still appears, with its file and line', () => {
  const s = { pair: PAIR.id, family: 'pause/resume', path: 'k.ts', owner: 'K', field: 'sealed', value: 'true', stop: { ...PAIR.stop, setAt: 6, setIn: PAIR.stop.fn }, start: PAIR.start, reads: [{ fn: 'k.ts::K.tick', name: 'tick', line: 20 }], readCount: 1, otherWrites: [], startOpen: false };
  const m = mk([box('pause.go', { refs: [cites('k.ts', 'K.pause')] })], []);
  const f = only(run(m, { sticky: [s] }), 'sticky-flag');
  assert.equal(f.length, 1);
  assert.match(f[0].question, /^`pause` sets `sealed` to true, `resume` never clears it\. Does anything read it after a resume\?$/);
  assert.deepEqual(f[0].boxes, ['pause.go']);
  const off = only(run(mk([box('x', { refs: [cites('z.ts', 'Z.z')] })], []), { sticky: [s] }), 'sticky-flag');
  assert.deepEqual(off[0].boxes, []);
  assert.match(off[0].evidence, /^No box on the map covers this \(k\.ts:6\)\./);
});

test('never-sent: an empty handler agrees with it (doubles its rank); the empty-handler check does not repeat it', () => {
  const ns = (name, empty) => ({ name, enum: 'V', member: name.split('.')[1], path: 'v.ts', line: 1, handled: [{ fn: 'h.ts::handle', path: 'h.ts', line: 12, ctx: 'case', empty }], handlerCount: 1, handlerEmpty: empty });
  const m = mk([box('h', { refs: [cites('h.ts', 'handle', 12)] })], []);
  const f = run(m, { neverSent: [ns('V.Shut', true), ns('V.Wave', false)], emptyHandlers: [{ kind: 'case', fn: 'h.ts::handle', path: 'h.ts', line: 12, end: 12, name: 'V.Shut', label: 'V.Shut', commented: false }] });
  const a = f.find((x) => x.key === 'never-sent:V.Shut'), b = f.find((x) => x.key === 'never-sent:V.Wave');
  assert.ok(a.agree > b.agree || a.agree === 2, 'empty handler counts as a second check');
  assert.deepEqual(a.also, ['empty-handler']);
  assert.match(a.evidence, /handler body is empty/);
  assert.equal(only(f, 'empty-handler').length, 0);
  assert.match(a.question, /^`V\.Shut` is handled but nothing sends it\. Was the sender lost, or is the handler a leftover\?$/);
});

test('empty-handler: only where a stop, close, cancel or abort road is', () => {
  const eh = { kind: 'lifecycle', fn: 'k.ts::K.close', path: 'k.ts', line: 30, end: 30, name: 'close', commented: false, owner: 'K' };
  const onRoad = mk([box('shut', { title: 'Close the link', refs: [cites('k.ts', 'K.close', 30)] }), box('x')], [route('r', 'x', 'shut', 'If stop asked')]);
  const f = only(run(onRoad, { emptyHandlers: [eh] }), 'empty-handler');
  assert.equal(f.length, 1);
  assert.match(f[0].question, /^`close\(\)` does nothing here\. What does a caller expect\?$/);
  const plain = mk([box('other', { refs: [cites('k.ts', 'K.close', 30)] }), box('x')], [route('r', 'x', 'other', 'If big')]);
  assert.equal(only(run(plain, { emptyHandlers: [eh] }), 'empty-handler').length, 0);
  const noBox = only(run(mk([box('q', { refs: [cites('q.ts', 'Q.q')] })], []), { emptyHandlers: [eh, { ...eh, kind: 'handler', name: 'onData' }] }), 'empty-handler');
  assert.equal(noBox.length, 1, 'off the map only a lifecycle method itself qualifies');
  assert.match(noBox[0].evidence, /^No box on the map covers this \(k\.ts:30\)\./);
});

test('swallowed-error: live boxes only, narrow and clean-up ones skipped, at most 20, the most central first', () => {
  const rows = [];
  const boxes = [box('hub', { refs: [cites('s.ts', 'f0', 3)] })];
  for (let i = 1; i <= 25; i++) { boxes.push(box(`b${i}`, { refs: [cites('s.ts', `f${i}`, 3)] })); }
  const routes = [route('in1', 'b1', 'hub'), route('in2', 'b2', 'hub'), route('in3', 'b3', 'hub')];
  for (let i = 0; i <= 25; i++) rows.push({ fn: `s.ts::f${i}`, path: 's.ts', line: 3, end: 5, kind: 'catch', broad: true, empty: true, comment: '', cleanup: false, teardown: false, only: '' });
  rows.push({ fn: 's.ts::f1', path: 's.ts', line: 9, end: 10, kind: 'except', broad: false, empty: true, comment: '', cleanup: false, only: 'pass' });
  rows.push({ fn: 's.ts::f2', path: 's.ts', line: 11, end: 12, kind: 'catch', broad: true, empty: true, comment: '', cleanup: true, only: '' });
  const m = mk(boxes, routes);
  const f = only(run(m, { swallowed: rows }), 'swallowed-error');
  assert.equal(f.length, 20);
  assert.deepEqual(f[0].boxes, ['hub'], 'the box with the most roads in comes first');
  assert.equal(f[0].question, 'This failure disappears here. Who finds out?');
  assert.ok(!f.some((x) => /s\.ts:(9|11)\b/.test(x.evidence)), 'narrow and clean-up handlers are not listed');
  const off = mk(boxes.map((b) => (b.id === 'hub' ? { ...b, status: 'off' } : b)), routes);
  assert.ok(!only(run(off, { swallowed: rows }), 'swallowed-error').some((x) => x.boxes.includes('hub')), 'a box that is not live is skipped');
  const talk = { fn: 's.ts::f1', path: 's.ts', line: 3, end: 4, kind: 'catch', broad: true, empty: true, comment: 'Lets the next poll retry quietly instead', cleanup: false, only: '' };
  const pair = only(run(mk([box('a', { refs: [cites('s.ts', 'f1', 3)] }), box('c', { refs: [cites('s.ts', 'f2', 3)] })], []), { swallowed: [talk, { ...talk, fn: 's.ts::f2', comment: '' }] }), 'swallowed-error');
  assert.deepEqual(pair.map((x) => x.boxes[0]), ['c', 'a'], 'a failure someone explained in a comment goes after one nobody explained');
});

test('wait-no-wake: a wait with no way to end it by time, a person or a cancel; a stop-like road in ranks it higher', () => {
  const m = mk([box('src'), box('stopper', { title: 'Stop the feed' }), box('w1', { kind: 'wait' }), box('w2', { kind: 'wait' }), box('w3', { kind: 'wait', plain: 'Waits up to 30 seconds for a reply' }), box('w4', { kind: 'wait' }), box('done', { kind: 'end' })],
    [route('a', 'src', 'w1', 'If sent'), route('b', 'w1', 'done', 'If reply arrives'), route('c', 'stopper', 'w2', 'If asked'), route('d', 'w2', 'done', 'If reply arrives'), route('e', 'src', 'w3'), route('f', 'w3', 'done', 'If reply'),
      route('g', 'src', 'w4', 'If sent'), route('h', 'w4', 'done', 'Sender picks Cancel')]);
  const f = only(run(m), 'wait-no-wake');
  assert.deepEqual(f.map((x) => x.boxes[0]), ['w2', 'w1'], 'w3 names a time; w4 has a cancel exit; the stop-like feed puts w2 first');
  assert.equal(f[0].question, 'What wakes this if nothing arrives?');
  assert.match(f[0].evidence, /Roads in come from stopper, when "If asked"\./);
  const looped = mk(m.boxes, m.routes, { loops: [{ id: 'lp', title: 'Spin', boxes: ['w1'], limit: 'at most 5 times' }] });
  assert.ok(!only(run(looped), 'wait-no-wake').some((x) => x.boxes[0] === 'w1'), 'a stated loop limit bounds the wait');
});

test('shared-decision: 2+ other stages, or 1 stage whose road in is inside a loop or a transaction; the question is what each caller has finished', () => {
  const m = mk([box('d', { kind: 'decision', stage: 's1' }), box('a', { stage: 's2' }), box('b', { stage: 's3' }), box('c', { stage: 's4', plain: 'Takes a lock and commits the batch' }), box('same', { stage: 's1' })],
    [route('r1', 'a', 'd'), route('r2', 'b', 'd'), route('r3', 'c', 'd'), route('r4', 'same', 'd')], { loops: [{ id: 'lp', title: 'Again', boxes: ['a'], limit: '' }] });
  const f = only(run(m), 'shared-decision');
  assert.equal(f.length, 1);
  assert.equal(f[0].question, 'd is reached from a, c and b. What has each one finished when it gets here? Is what this test reads complete for all of them?');
  assert.match(f[0].evidence, /a \(stage s2, inside a declared loop\)/);
  assert.match(f[0].evidence, /c \(stage s4, looks transaction-like\)/);
  assert.match(f[0].evidence, /b \(stage s3\)/, 'a caller that is neither is named too, with its stage');
  assert.match(f[0].evidence, /the shape is a helper that reads shared state partway through a batch/i);
  assert.match(f[0].evidence, /^This test has roads in from 4 boxes: /, 'no check word first, no box name said twice');
  assert.match(f[0].evidence, /2 of them sit inside a declared loop or look transaction-like\./, 'plural verbs agree');
  assert.ok(!/candidate|decision "/.test(f[0].evidence));
  assert.match(f[0].evidence, /A dismissal has to answer the question asked; "one function, same arguments" is not an answer\./);
  const allLoop = mk(m.boxes, m.routes, { loops: [{ id: 'lp', title: 'Again', boxes: ['a', 'b', 'c', 'same'], limit: '' }] });
  assert.equal(only(run(allLoop), 'shared-decision').length, 0, 'every road comes from inside the loop: the contexts do not differ');
  const twoStages = mk(m.boxes.map((b) => (b.id === 'c' ? { ...b, stage: 's3' } : b)), m.routes, { loops: m.loops });
  assert.equal(only(run(twoStages), 'shared-decision').length, 1, 'two other stages are enough (the count is not fitted to what readers dismiss)');
  const oneFar = mk([box('d', { kind: 'decision', stage: 's1' }), box('a', { stage: 's2' }), box('b', { stage: 's2' }), box('c', { stage: 's2' })], [route('r1', 'a', 'd'), route('r2', 'b', 'd'), route('r3', 'c', 'd')], { loops: [{ id: 'lp', title: 'Again', boxes: ['a'], limit: '' }] });
  assert.equal(only(run(oneFar), 'shared-decision').length, 1, 'one other stage, and the road in from inside a loop comes from that stage');
  const oneNear = mk([box('d', { kind: 'decision', stage: 's1' }), box('a', { stage: 's1' }), box('b', { stage: 's2' }), box('c', { stage: 's2' })], [route('r1', 'a', 'd'), route('r2', 'b', 'd'), route('r3', 'c', 'd')], { loops: [{ id: 'lp', title: 'Again', boxes: ['a'], limit: '' }] });
  assert.equal(only(run(oneNear), 'shared-decision').length, 0, 'one other stage, and the loop is in the decision\'s own stage: not enough');
  const wide = mk([...m.boxes, box('e', { stage: 's2' }), box('f', { stage: 's2' }), box('g', { stage: 's3' })], [...m.routes, route('r5', 'e', 'd'), route('r6', 'f', 'd'), route('r7', 'g', 'd')], { loops: m.loops });
  assert.equal(only(run(wide), 'shared-decision').length, 0, 'more than six roads in: a shared helper by design');
});

test('ranking: kept suspects first, then agreement, then the fixed check order; no-limit-loop comes last of the checks', () => {
  assert.deepEqual(CHECKS.slice(0, 8), ['lost-wakeup', 'sticky-flag', 'restart-misses', 'never-sent', 'shared-decision', 'wait-no-wake', 'empty-handler', 'swallowed-error']);
  assert.equal(CHECKS[CHECKS.length - 1], 'no-limit-loop');
  const m = mk([box('start', { refs: [cites('x.ts', 'x')] }), box('w', { kind: 'wait' }), box('u'), box('v'), box('end', { kind: 'end' })],
    [route('r1', 'start', 'w', 'If sent'), route('r2', 'w', 'end', 'If reply arrives'), route('r3', 'u', 'v'), route('r4', 'v', 'u', 'If again', { type: 'return' }), route('r5', 'start', 'u'), route('r6', 'v', 'end', 'If finished')], { loops: [{ id: 'lp', title: 'Spin', boxes: ['u', 'v'], limit: '' }] });
  const all = run(m);
  const order = all.map((x) => x.check);
  assert.ok(order.indexOf('wait-no-wake') < order.indexOf('no-limit-loop'), order.join());
  const kept = run(m, null, { 'no-limit-loop:lp': { suspect: true, why: 'a person read the code' } });
  assert.equal(kept[0].key, 'no-limit-loop:lp', 'a kept suspect goes first');
  assert.equal(kept[0].resolution.state, 'suspect');
  assert.deepEqual(run(m).map((x) => x.key), run(m).map((x) => x.key), 'stable');
});

test('analyze says when signals.json is missing; every sentence stays in plain words', () => {
  const m = mk([box('a')], []);
  assert.ok(run(m).notes.some((n) => /no signals\.json/.test(n)));
  assert.ok(!run(m, { pairs: [] }).notes.some((n) => /no signals\.json/.test(n)));
  const sentences = [];
  const f = run(mk([box('hub', { refs: [cites('s.ts', 'f', 3)] })], []), { swallowed: [{ fn: 's.ts::f', path: 's.ts', line: 3, end: 4, kind: 'except', broad: true, empty: true, comment: '', cleanup: false, only: '' }], sticky: [], neverSent: [] });
  for (const x of f) sentences.push(x.question, x.evidence);
  assert.ok(sentences.every((s) => !hasBannedWord(s)));
});

test('breaks: held-back candidates are counted by check, and a candidate on no box says so', () => {
  const data = { boxes: {}, routes: {}, stages: [], charts: [], loops: [], paths: [], main: [], counts: {}, census: {}, notDrawn: {}, gaps: [], system: {}, state: 'draft', pin: '', evidence: null, fnRanges: {},
    findings: [
      { key: 'swallowed-error:a:f:3', check: 'swallowed-error', boxes: [], routes: [], question: 'This failure disappears here. Who finds out?', evidence: 'candidate on no box (a.ts:3): catch ...', cluster: '', agree: 1, shown: true, resolution: null },
      { key: 'no-limit-loop:l1', check: 'no-limit-loop', boxes: [], routes: [], question: 'q', evidence: 'e', cluster: '', agree: 1, shown: false, resolution: null },
      { key: 'no-limit-loop:l2', check: 'no-limit-loop', boxes: [], routes: [], question: 'q', evidence: 'e', cluster: '', agree: 1, shown: false, resolution: null },
      { key: 'pile-up:p', check: 'pile-up', boxes: [], routes: [], question: 'q', evidence: 'e', cluster: '', agree: 1, shown: false, resolution: null }] };
  const out = breaks(data);
  assert.match(out, /\[no box cites it\]/);
  assert.match(out, /Showing 1 of 4 open candidate\(s\)\. 3 more held back \(0 kept, 3 open; lower rank: 2 no-limit-loop, 1 pile-up\): faultline breaks --all/);
});

// ---- lost-wakeup ----------------------------------------------------------------------------------------------------------------------
// One small class per case, in both languages. A flag is flipped so a loop carries on; does anything wake the loop if it is parked?
const WAKE_TS = `
export class Gauge {
  private paused = false;
  private idle = true;
  private queue = new Q();
  pause() { this.paused = true; }
  resume() { this.paused = false; if (this.idle) { this.loop(); } }
  async loop() { while (!this.paused) { const j = await this.queue.next(); work(j); } }
}
export class Steady {
  private paused = false;
  pause() { this.paused = true; }
  resume() { this.paused = false; this.kick(); }
  kick() { this.spin(); }
  async spin() { while (!this.paused) { await this.q.next(); } }
}
export class Poller {
  private paused = false;
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  async tick() { while (!this.paused) { await sleep(100); } }
}
export class Waker {
  private paused = false;
  private gate = new Gate();
  pause() { this.paused = true; }
  resume() { this.paused = false; this.gate.notify(); }
  async run() { while (!this.paused) { await this.gate.wait(); } }
}
export class HalfWaker {
  private paused = false;
  private gate = new Gate();
  pause() { this.paused = true; }
  resume(now: boolean) { this.paused = false; if (now) { this.gate.notify(); } }
  async run() { while (!this.paused) { await this.gate.wait(); } }
}
export class Both {
  private paused = false;
  pause() { this.paused = true; }
  resume(a: boolean) { this.paused = false; if (a) { this.spin(); } else { this.gate.notify(); } }
  async spin() { while (!this.paused) { await this.q.next(); } }
}
export class Early {
  private paused = false;
  private ready = false;
  pause() { this.paused = true; }
  resume() { this.paused = false; if (!this.ready) { return; } this.spin(); }
  async spin() { while (!this.paused) { await this.q.next(); } }
}
export class Emitter {
  private paused = false;
  pause() { this.paused = true; }
  resume() { this.paused = false; this.emit('resumed'); }
  async spin() { while (true) { if (this.paused) { continue; } await this.q.next(); } }
}
`;
const WAKE_PY = `
import threading, time

class Gauge:
    def __init__(self):
        self.paused = False
        self.idle = True
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
        if self.idle:
            self.loop()
    async def loop(self):
        while not self.paused:
            job = await self.queue.get()

class Steady:
    def __init__(self):
        self.paused = False
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
        self.kick()
    def kick(self):
        self.spin()
    def spin(self):
        while not self.paused:
            item = self._q.get()

class Poller:
    def __init__(self):
        self.paused = False
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
    def tick(self):
        while not self.paused:
            time.sleep(0.1)

class Waker:
    def __init__(self):
        self.paused = False
        self._ev = threading.Event()
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
        self._ev.set()
    def run(self):
        while not self.paused:
            self._ev.wait()

class HalfWaker:
    def __init__(self):
        self.paused = False
        self._ev = threading.Event()
    def pause(self):
        self.paused = True
    def resume(self, now):
        self.paused = False
        if now:
            self._ev.set()
    def run(self):
        while not self.paused:
            self._ev.wait()

class Early:
    def __init__(self):
        self.paused = False
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
        if not self.ready:
            return
        self.spin()
    def spin(self):
        while not self.paused:
            item = self._q.get()

class Emitter:
    def __init__(self):
        self.paused = False
    def pause(self):
        self.paused = True
    def resume(self):
        self.paused = False
        self.emit("resumed")
    def spin(self):
        while True:
            if self.paused:
                continue
            item = self._q.get()
`;
let wake;
before(async () => {
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-wake-'));
  try {
    fs.writeFileSync(path.join(d3, 'gauge.ts'), WAKE_TS);
    fs.writeFileSync(path.join(d3, 'gauge.py'), WAKE_PY);
    wake = await buildSignals(d3, [{ path: 'gauge.ts', lang: 'ts' }, { path: 'gauge.py', lang: 'py' }]);
  } finally { fs.rmSync(d3, { recursive: true, force: true }); }
});
const wakeRows = (file) => wake.lostWakeup.filter((w) => w.path === file);

test('lostWakeup (TypeScript): a parked loop the start side wakes only on some paths fires; always-wake, polling and notify do not', () => {
  const rows = wakeRows('gauge.ts');
  assert.deepEqual(rows.filter((w) => !w.polls).map((w) => w.owner).sort(), ['Early', 'Emitter', 'Gauge', 'HalfWaker'],
    'Gauge: one branch calls the loop. Early: returns before it. HalfWaker: notifies in one branch. Emitter: an emit is not a wake. Steady (always, through a helper), Waker (notify on every path) and Both (both branches wake) do not appear');
  const g = rows.find((w) => w.owner === 'Gauge');
  assert.equal(g.field, 'paused');
  assert.deepEqual([g.stop.name, g.start.name, g.loop.name, g.loop.how], ['pause', 'resume', 'loop', 'condition']);
  assert.equal(g.start.value, 'false'); assert.equal(g.stop.value, 'true');
  assert.deepEqual(g.startCalls.map((c) => c.name), ['loop']);
  assert.ok(g.blocks.some((b) => b.kind === 'await' && !b.timed && b.name === 'next' && b.recv === '@.queue'));
  assert.ok(g.loop.line < g.loop.readAt + 1 && g.loop.readAt >= g.loop.line && g.start.restoreAt > g.start.line - 1, 'every part carries its line');
  assert.equal(rows.find((w) => w.owner === 'Emitter').loop.how, 'guard', 'an `if` directly in the loop body that skips reads it too');
  const e = rows.find((w) => w.owner === 'Early');
  assert.deepEqual(e.startCalls.map((c) => c.name), ['spin'], 'a return before the call makes the call conditional');
  assert.deepEqual(rows.find((w) => w.owner === 'HalfWaker').startWakes.map((x) => [x.name, x.recv]), [['notify', '@.gate']]);
  const p = rows.find((w) => w.owner === 'Poller');
  assert.equal(p.polls, true, 'its only blocking call is a sleep with a time: it re-checks the flag by itself');
  assert.ok(!rows.some((w) => ['Steady', 'Waker', 'Both'].includes(w.owner)));
});

test('lostWakeup (Python): the same cases, with Event.set() as the wake and queue.get() as the park', () => {
  const rows = wakeRows('gauge.py');
  assert.deepEqual(rows.filter((w) => !w.polls).map((w) => w.owner).sort(), ['Early', 'Emitter', 'Gauge', 'HalfWaker']);
  const h = rows.find((w) => w.owner === 'HalfWaker');
  assert.deepEqual(h.startWakes.map((x) => [x.name, x.recv]), [['set', '@._ev']]);
  assert.ok(h.blocks.some((b) => b.name === 'wait' && b.recv === '@._ev' && !b.timed));
  assert.equal(rows.find((w) => w.owner === 'Poller').polls, true, 'time.sleep(0.1) is a plain sleep');
  assert.equal(rows.find((w) => w.owner === 'Emitter').loop.how, 'guard');
  assert.ok(rows.find((w) => w.owner === 'Gauge').blocks.some((b) => b.kind === 'await' && b.name === 'get'));
  assert.ok(!rows.some((w) => ['Steady', 'Waker'].includes(w.owner)), 'Steady calls the loop on every path (through kick); Waker sets the event on every path');
});

test('lost-wakeup: the question names the real functions; polling loops are not reported; it ranks above sticky-flag; evidence has a line for each part', () => {
  const w = wakeRows('gauge.ts').find((x) => x.owner === 'Gauge'), poll = wakeRows('gauge.ts').find((x) => x.owner === 'Poller');
  const m = mk([box('go', { refs: [cites('gauge.ts', 'Gauge.resume', w.start.line)] }), box('lp', { refs: [cites('gauge.ts', 'Gauge.loop', w.loop.line)] })], [route('r', 'go', 'lp')]);
  const f = run(m, { lostWakeup: [w, poll] });
  const lw = only(f, 'lost-wakeup');
  assert.equal(lw.length, 1, 'the polling row is kept in signals.json but not reported');
  assert.equal(lw[0].question, '`resume` clears `paused`, which the loop in `loop` reads, but only calls it in one branch. If that loop is parked, what wakes it?');
  assert.deepEqual(lw[0].boxes, ['go', 'lp']);
  for (const part of [`gauge.ts:${w.stop.setAt}`, `gauge.ts:${w.start.line}`, `gauge.ts:${w.start.restoreAt}`, `gauge.ts:${w.loop.line}-${w.loop.end}`, `gauge.ts:${w.loop.readAt}`, `gauge.ts:${w.blocks[0].line}`, `gauge.ts:${w.startCalls[0].line}`]) assert.ok(lw[0].evidence.includes(part), `evidence names ${part}`);
  assert.match(lw[0].evidence, /An emit is not a wake/);
  assert.match(lw[0].evidence, /A dismissal has to answer the question asked; "one function, same arguments" is not an answer\./);
  const never = only(run(m, { lostWakeup: [{ ...w, startCalls: [] }] }), 'lost-wakeup')[0];
  assert.match(never.question, /but never calls it\. If that loop is parked/);
  assert.equal(CHECKS[0], 'lost-wakeup');
  const s = { pair: PAIR.id, family: 'pause/resume', path: 'gauge.ts', owner: 'K', field: 'sealed', value: 'true', stop: { ...PAIR.stop, setAt: 6, setIn: PAIR.stop.fn }, start: PAIR.start, reads: [], readCount: 0, otherWrites: [], startOpen: false };
  const both = run(mk([box('go', { refs: [cites('gauge.ts', 'Gauge.resume', w.start.line), cites('k.ts', 'K.pause', 6)] }), box('lp', { refs: [cites('gauge.ts', 'Gauge.loop', w.loop.line)] })], []), { lostWakeup: [w], sticky: [s] });
  assert.deepEqual(both.map((x) => x.check).slice(0, 2), ['lost-wakeup', 'sticky-flag']);
  assert.ok(only(f, 'lost-wakeup').every((x) => !hasBannedWord(x.question) && !hasBannedWord(x.evidence)));
});

// ---- restart-misses: a pause normally leads to a paused wait and then to its resume ---------------------------------------------------
test('restart-misses: with a wait between stop and start, compare what stop reaches BEFORE the wait with what start reaches after it', () => {
  const m = mk([box('pause.go', { refs: [cites('k.ts', 'K.pause')] }), box('paused', { kind: 'wait', title: 'Paused' }), box('resume.go', { refs: [cites('k.ts', 'K.resume')] }), box('run'), box('l.a'), box('l.b')],
    [route('r1', 'pause.go', 'paused', 'If asked'), route('r2', 'paused', 'resume.go', 'If resumed'), route('r3', 'resume.go', 'run'), route('r4', 'pause.go', 'l.a'), route('r5', 'l.a', 'l.b'), route('r6', 'l.b', 'l.a', 'If again', { type: 'return' })],
    { loops: [{ id: 'lp', title: 'Main loop', boxes: ['l.a', 'l.b'], limit: '' }] });
  const f = only(run(m, { pairs: [PAIR] }), 'restart-misses');
  assert.equal(f.length, 1, 'the old rule dropped every pause that leads on to its resume');
  assert.match(f[0].question, /`pause` reaches l\.a, the entry of a loop; `resume` doesn't reach it\. What wakes that loop after a resume\?/);
  assert.match(f[0].evidence, /A wait \(paused\) lies between `pause` and `resume`, so this compares what `pause` reaches before it with what `resume` reaches after it/);
  assert.ok(!f[0].boxes.includes('paused'), 'the wait between them is the pause itself, not a miss');
  const back = mk(m.boxes, [...m.routes, route('r7', 'run', 'l.a')], { loops: m.loops });
  assert.equal(only(run(back, { pairs: [PAIR] }), 'restart-misses').length, 0, 'once the start side reaches the loop after the wait, nothing is missing');
  const chain = mk([box('pause.go', { refs: [cites('k.ts', 'K.pause')] }), box('mid'), box('resume.go', { refs: [cites('k.ts', 'K.resume')] }), box('l.a'), box('l.b')],
    [route('r1', 'pause.go', 'mid'), route('r2', 'mid', 'resume.go'), route('r4', 'pause.go', 'l.a'), route('r5', 'l.a', 'l.b'), route('r6', 'l.b', 'l.a', 'If again', { type: 'return' })], { loops: m.loops });
  assert.equal(only(run(chain, { pairs: [PAIR] }), 'restart-misses').length, 0, 'no wait between: one switch drawn as a chain, still exempt');
  const caller = mk([box('outside', { kind: 'external', refs: [cites('k.ts', 'K.pause'), cites('k.ts', 'K.resume')] }), ...m.boxes.filter((b) => b.id !== 'pause.go' && b.id !== 'resume.go'), box('x')],
    [route('o1', 'outside', 'l.a'), route('o2', 'outside', 'x')], { loops: m.loops });
  assert.equal(only(run(caller, { pairs: [PAIR] }), 'restart-misses').length, 0, 'an external box is the outside caller: its roads say nothing about what pause or resume do');
});

// ---- leads, slots, orphans ------------------------------------------------------------------------------------------------------------
const swallow = (i, o = {}) => ({ fn: `s.ts::f${i}`, path: 's.ts', line: 3 + i, end: 5 + i, kind: 'catch', broad: true, empty: true, comment: '', cleanup: false, teardown: false, only: '', ...o });

test('swallowed-error is a lead: not shown by default, not a candidate, not counted by gate A1, listed with --all and breaks --leads', () => {
  const m = mk([box('hub', { refs: [cites('s.ts', 'f1', 4)] }), box('done', { kind: 'end' })], [route('r', 'hub', 'done')]);
  const f = run(m, { swallowed: [swallow(1)] });
  assert.deepEqual(f.map((x) => x.check), ['swallowed-error'], 'nothing else fires on this map');
  const sw = only(f, 'swallowed-error');
  assert.equal(sw.length, 1);
  assert.equal(sw[0].lead, true); assert.equal(sw[0].shown, false);
  assert.match(sw[0].evidence, /^A `catch` at s\.ts:4 is an empty block\./);
  const gates = validateModel(m, null, null, { finished: true, findings: f, dismissed: {} });
  assert.ok(!gates.refusals.some((r) => r.code === 'A1'), 'a lead is not an unresolved finding');
  assert.equal(validateModel(m, null, null, { finished: false, findings: f, dismissed: {} }).gaps.notDrawn.findings.count, 0);
  const sticky = { pair: PAIR.id, family: 'pause/resume', path: 'k.ts', owner: 'K', field: 'sealed', value: 'true', stop: { ...PAIR.stop, setAt: 6, setIn: PAIR.stop.fn }, start: PAIR.start, reads: [], readCount: 0, otherWrites: [], startOpen: false };
  const f2 = run(m, { swallowed: [swallow(1)], sticky: [sticky] });
  assert.ok(!only(f2, 'sticky-flag')[0].lead, 'sticky-flag stays a candidate');
  assert.equal(validateModel(m, null, null, { finished: true, findings: f2, dismissed: {} }).refusals.find((r) => r.code === 'A1').offenders.length, 1, 'only the sticky flag is open');
  const kept = run(m, { swallowed: [swallow(1)] }, { [sw[0].key]: { suspect: true, why: 'a person read it' } });
  assert.equal(kept[0].lead, undefined, 'kept as a suspect, it is a candidate now');
  // breaks: default hides it and says so; --leads lists it
  const data = (fs_) => ({ boxes: {}, routes: {}, stages: [], charts: [], loops: [], paths: [], main: [], counts: {}, census: {}, notDrawn: {}, gaps: [], system: {}, state: 'draft', pin: '', evidence: null, fnRanges: {}, findings: fs_.map((x) => ({ key: x.key, check: x.check, boxes: x.boxes, routes: [], question: x.question, evidence: x.evidence, cluster: '', agree: x.agree, shown: x.shown, resolution: x.resolution || null, ...(x.lead ? { lead: true } : {}) })) });
  const d = data(f);
  assert.ok(!/swallowed-error:/.test(breaks(d)), 'not in the default view');
  assert.match(breaks(d), /1 lead\(s\) kept out \(1 swallowed-error\): they do not count as candidates; faultline breaks --leads/);
  const l = breaks(d, { leads: true });
  assert.match(l, /BREAKS --leads 1 lead\(s\)/);
  assert.match(l, /swallowed-error:s\.ts:f1:4.*LEAD/);
});

test('slots: kept suspects take at most half of the 10, open candidates fill the rest by rank, and the header counts both', () => {
  const boxes = [], routes = [], loops = [];
  for (let i = 1; i <= 22; i++) { boxes.push(box(`u${i}`), box(`v${i}`)); routes.push(route(`a${i}`, `u${i}`, `v${i}`), route(`b${i}`, `v${i}`, `u${i}`, 'If again', { type: 'return' })); loops.push({ id: `l${i}`, title: `Spin ${i}`, boxes: [`u${i}`, `v${i}`], limit: '' }); }
  const m = mk(boxes, routes, { loops });
  const dismissed = {};
  for (let i = 1; i <= 14; i++) dismissed[`no-limit-loop:l${i}`] = { suspect: true, why: 'a person read the code' };
  const f = run(m, null, dismissed);
  assert.equal(f.filter((x) => x.shown).length, 10);
  assert.equal(f.filter((x) => x.shown && x.resolution?.state === 'suspect').length, 5, 'at most 5 kept suspects');
  assert.equal(f.filter((x) => x.shown && !x.resolution).length, 5, 'the other 5 go to open candidates, so new shapes show');
  assert.ok(f.slice(0, 5).every((x) => x.resolution?.state === 'suspect'), 'kept suspects still sort first');
  const few = run(mk(boxes.slice(0, 8), routes.slice(0, 8), { loops: loops.slice(0, 4) }), null, Object.fromEntries([1, 2, 3, 4].map((i) => [`no-limit-loop:l${i}`, { suspect: true, why: 'read' }])));
  assert.equal(few.filter((x) => x.shown).length, 4, 'with no open candidates, kept suspects fill the slots they have');
  const data = { boxes: {}, routes: {}, stages: [], charts: [], loops: [], paths: [], main: [], counts: {}, census: {}, notDrawn: {}, gaps: [], system: {}, state: 'draft', pin: '', evidence: null, fnRanges: {},
    findings: f.map((x) => ({ key: x.key, check: x.check, boxes: x.boxes, routes: [], question: x.question, evidence: x.evidence, cluster: '', agree: x.agree, shown: x.shown, resolution: x.resolution || null })) };
  const openN = f.filter((x) => !x.resolution && !x.lead).length;
  assert.ok(breaks(data).includes(`Showing 5 of 14 kept suspect(s) (already read) and 5 of ${openN} open candidate(s). ${9 + openN - 5} more held back (9 kept, ${openN - 5} open;`), breaks(data).slice(0, 400));
});

test('dismissals: one whose key no longer fires stays in the file and is counted as an orphan, not an error', () => {
  const m = mk([box('a'), box('b')], [route('r', 'a', 'b')]);
  const f = run(m, { pairs: [] }, { 'no-limit-loop:gone': { why: 'it was dismissed once' }, 'sticky-flag:old.ts::K.x:flag': { why: 'also gone' } });
  assert.deepEqual([...f.orphans].sort(), ['no-limit-loop:gone', 'sticky-flag:old.ts::K.x:flag']);
  assert.ok(f.notes.some((n) => /2 entries in dismissed\.json match no candidate now \(kept in the file, not an error\)/.test(n)));
  const none = run(m, null, { 'sticky-flag:old.ts::K.x:flag': { why: 'cannot judge without signals.json' } });
  assert.deepEqual([...none.orphans], [], 'without signals.json a signal check\'s keys are not judged');
});

// ---- small things ---------------------------------------------------------------------------------------------------------------------
test('gates: flag: takes a space after the colon; a decision whose only extra exit is a road back to itself has two exits', () => {
  for (const ok of ['flag: --name', 'flag:--name', 'env: HOME', 'setting:  x']) assert.ok(SWITCH_NOTE.test(ok), ok);
  assert.ok(!SWITCH_NOTE.test('flag:') && !SWITCH_NOTE.test('flag: '));
  const warn = (routes) => validateModel(mk([box('d', { kind: 'decision' }), box('x')], routes), null, null, {}).warnings.filter((w) => w.code === 'W-decision-one-exit').map((w) => w.at);
  assert.deepEqual(warn([route('r1', 'd', 'x')]), ['d'], 'one exit');
  assert.deepEqual(warn([route('r1', 'd', 'x'), route('r2', 'd', 'd', 'If again')]), [], 'a self-loop is an exit');
  assert.deepEqual(warn([route('r2', 'd', 'd', 'If again')]), ['d'], 'only the self-loop: still one exit');
});

test('analyze --dismiss and --keep record who answered: --by, else "agent", never "unknown"', async () => {
  const { analyzeCmd } = await import('../bin/cmds_project.mjs');
  const TOY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'toy', '.faultline');
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'faultline-by-')), proj = path.join(d4, '.faultline');
  fs.cpSync(TOY, proj, { recursive: true });
  try { fs.unlinkSync(path.join(proj, 'dismissed.json')); } catch { /* none */ }
  const log = console.log; console.log = () => {};
  try {
    await analyzeCmd(['--project', proj, '--dismiss', 'k1', '--why', 'because']);
    await analyzeCmd(['--project', proj, '--keep', 'k2', '--why', 'read it']);
    await analyzeCmd(['--project', proj, '--dismiss', 'k3', '--why', 'because', '--by', 'Dana']);
  } finally { console.log = log; }
  const j = JSON.parse(fs.readFileSync(path.join(proj, 'dismissed.json'), 'utf8'));
  assert.equal(j.k1.by, 'agent'); assert.equal(j.k2.by, 'agent'); assert.equal(j.k3.by, 'Dana');
  assert.equal(j.k2.suspect, true); assert.match(j.k1.at, /^\d{4}-\d\d-\d\d$/);
  assert.ok(!JSON.stringify(j).includes('unknown'));
  fs.rmSync(d4, { recursive: true, force: true });
});

test('shared-decision: above 25 on one map the most-ranked 25 are listed and the rest are counted in a note', () => {
  const boxes = [], routes = [], loop = [];
  for (let i = 1; i <= 27; i++) {
    boxes.push(box(`d${i}`, { kind: 'decision', stage: 's1' }), box(`a${i}`, { stage: 's2' }), box(`b${i}`, { stage: 's3' }), box(`c${i}`, { stage: 's3', plain: i <= 3 ? 'Takes a lock and commits the batch' : 'plain' }));
    routes.push(route(`ra${i}`, `a${i}`, `d${i}`), route(`rb${i}`, `b${i}`, `d${i}`), route(`rc${i}`, `c${i}`, `d${i}`));
    loop.push(`a${i}`);
  }
  const f = run(mk(boxes, routes, { loops: [{ id: 'lp', title: 'Again', boxes: loop, limit: '' }] }));
  const sd = only(f, 'shared-decision');
  assert.equal(sd.length, 25);
  assert.ok(['d1', 'd2', 'd3'].every((id) => sd.some((x) => x.key === `shared-decision:${id}`)), 'the ones with a transaction-like caller as well as a loop caller are ranked into the 25');
  assert.ok(f.notes.some((n) => /27 found, the 25 .* listed and 2 are held back/.test(n)));
});

// ---- the words a reader sees in evidence: a plain sentence, no check word first, no box name said twice, plural verbs that agree, no road id ---------------
test('evidence reads as plain sentences: one caller in a loop says "1 of them sits"; no check word leads; the box name is said once; no route id', () => {
  const m = mk([box('d', { kind: 'decision', stage: 's1', title: 'Is the request valid?' }), box('a', { stage: 's2' }), box('b', { stage: 's3' }), box('c', { stage: 's4' })],
    [route('r1', 'a', 'd'), route('r2', 'b', 'd'), route('r3', 'c', 'd')], { loops: [{ id: 'lp', title: 'Again', boxes: ['a'], limit: '' }] });
  const f = only(run(m), 'shared-decision');
  assert.equal(f.length, 1);
  assert.match(f[0].evidence, /1 of them sits inside a declared loop or looks transaction-like\./);
  assert.ok(!/\b1 of them sit\b/.test(f[0].evidence));
  assert.ok(!/^(candidate|decision|lead)\b/i.test(f[0].evidence) && !/Is the request valid\?"/.test(f[0].evidence), f[0].evidence);
  for (const x of run(m)) {
    assert.ok(/^[A-Z0-9`]/.test(x.evidence), `evidence starts with a capital, a number or a code span: ${x.evidence.slice(0, 40)}`);
    assert.ok(!/\b(?:r|x)_[a-z0-9]+(?:_[a-z0-9]+)+\b/.test(x.evidence), `no route id: ${x.evidence.slice(0, 80)}`);
    assert.ok(!/\bcandidate\b/i.test(x.evidence), x.evidence);
  }
});

test('the checker\'s note rides on the evidence for the agent and is not on the reader\'s page', async () => {
  const { DISMISS_NOTE } = await import('../src/model/checks_wait.mjs');
  const { toAtlasData } = await import('../src/build/atlasdata.mjs');
  const m = mk([box('d', { kind: 'decision', stage: 's1' }), box('a', { stage: 's2' }), box('b', { stage: 's3' }), box('c', { stage: 's4' })],
    [route('r1', 'a', 'd'), route('r2', 'b', 'd'), route('r3', 'c', 'd')], { loops: [{ id: 'lp', title: 'Again', boxes: ['a'], limit: '' }] });
  const f = only(run(m), 'shared-decision');
  assert.ok(f[0].evidence.includes(DISMISS_NOTE), 'the agent still reads the note');
  const data = toAtlasData(m, { findings: f, charts: undefined });
  const rows = (data.breaks || []).filter((r) => r.check === 'shared-decision');
  assert.ok(rows.length >= 1 && rows.every((r) => !r.evidence.includes('A dismissal has to answer') && !r.evidence.includes(DISMISS_NOTE)), 'the page rows carry no note');
  assert.ok((data.findings || []).every((r) => !String(r.evidence).includes(DISMISS_NOTE)), 'nor do the findings the evidence layer reads');
});

test('signals.json holds no clock value: the same code gives the same file', async () => {
  const { writeSignals } = await import('../src/extract/signals.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-sig-'));
  writeSignals(dir, { schema: 'faultline.signals/1', root: dir, pairs: [], counts: { pairs: 0 }, seconds: 12.34 });
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'signals.json'), 'utf8'));
  assert.equal('seconds' in written, false);
  assert.equal(written.counts.pairs, 0);
});
