// Synthetic whole-system models for tests and timing runs: any number of stages, generic words, deterministic for a seed.
//   makeModel({ stages = 12, perStage = 20, seed = 1, cross = 0.8, returns = 0.12 }) -> faultline.model/1-shaped { system, stages, boxes, routes, paths }
import { rng } from './rng.mjs';

const VERBS = ['Read', 'Check', 'Split', 'Merge', 'Queue', 'Send', 'Hold', 'Retry', 'Sort', 'Log', 'Match', 'Open', 'Close', 'Score', 'Pack'];
const NOUNS = ['input', 'record', 'batch', 'token', 'ticket', 'lease', 'report', 'window', 'ledger', 'signal', 'request', 'result'];
const WHEN = ['ok', 'not ok', 'empty', 'too large', 'limit reached', 'seen before', 'late', 'done', 'refused', 'needs review'];

export function makeModel({ stages = 12, perStage = 20, seed = 1, cross = 0.8, returns = 0.12 } = {}) {
  const R = rng(seed), model = { system: { name: 'Synthetic system' }, stages: [], boxes: [], routes: [], paths: [] };
  const ids = [];
  for (let s = 0; s < stages; s++) {
    const sid = 's' + (s + 1), n = Math.max(3, Math.round(perStage * (0.7 + R() * 0.6)));
    model.stages.push({ id: sid, title: 'Stage ' + (s + 1), order: s + 1 });
    const mine = [];
    for (let i = 0; i < n; i++) {
      const id = `${sid}.b${i + 1}`, last = i === n - 1;
      const kind = last ? 'end' : R() < 0.22 ? 'decision' : R() < 0.1 ? 'wait' : R() < 0.1 ? 'store' : 'step';
      model.boxes.push({ id, stage: sid, kind, title: `${R.pick(VERBS)} ${R.pick(NOUNS)} ${s + 1}.${i + 1}`, plain: 'A generic step.', status: 'live', refs: [{ path: 'src/x.py', symbol: 'src/x.py::f', line: 1 }] });
      mine.push(id);
    }
    ids.push(mine);
    let k = 0; const route = (from, to, type, when) => model.routes.push({ id: `r${model.routes.length + 1}`, from, to, type, when: when || '' });
    for (let i = 0; i + 1 < n; i++) {
      route(mine[i], mine[i + 1], 'forward', model.boxes.find(b => b.id === mine[i]).kind === 'decision' ? R.pick(WHEN) : '');
      if (model.boxes.find(b => b.id === mine[i]).kind === 'decision' && i + 3 < n) route(mine[i], mine[Math.min(n - 1, i + 2 + R.int(3))], 'forward', R.pick(WHEN));
      if (i > 2 && R() < returns) route(mine[i], mine[R.int(i - 1)], 'return', R.pick(WHEN));
      k++;
    }
  }
  for (let s = 0; s + 1 < stages; s++) model.routes.push({ id: `r${model.routes.length + 1}`, from: ids[s][ids[s].length - 1], to: ids[s + 1][0], type: 'forward', when: 'next stage' });
  for (let s = 0; s < stages; s++) {
    if (R() > cross) continue;
    const t = clamp(s + (R() < 0.5 ? -1 : 1) * (1 + R.int(3)), 0, stages - 1); if (t === s) continue;
    const a = ids[s][R.int(ids[s].length)], b = ids[t][R.int(ids[t].length)];
    model.routes.push({ id: `r${model.routes.length + 1}`, from: a, to: b, type: R() < 0.3 ? 'record' : 'forward', when: R.pick(WHEN) });
  }
  model.paths.push({ id: 'main', title: 'Main path', boxes: ids.flat().filter((_, i) => true).filter(id => !id.endsWith('.b0')) });
  return model;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
