// Generic explorer runner (CONTRACTS section 9). Drives any adapter over JSON lines; knows nothing about the system.
//   node runner.mjs --run DIR [--out FILE] [--max-states N] [--max-evals N] [--max-seconds S] [--resume|--fresh]
//                   [--facts FILE] [--model-dir DIR] [--store sqlite|journal] [--allow-unguarded] -- <adapter command...>
//   node runner.mjs --replay WITNESS.json -- <adapter command...>
// Exits 0 when the run finished (findings or not), 3 when it refused, 2 on bad usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, canonical, Refusal } from '../util.mjs';
import { writeWalkFile } from '../walk.mjs';
import { AdapterClient, AdapterError, identityBuffer, checkClass, EXPANDS } from './adapter.mjs';
import { openStore, existingStore } from './store.mjs';

export const PROTOCOL = 'faultline.explorer/1';
const DEFAULT_BUDGETS = { states: 20000, evals: 200000, seconds: 120 };
const slug = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 48) || 'x';

const symOrTag = (at) => (String(at).includes('::') ? { sym: at } : { tag: at });

function checkManifest(m) {
  const bad = (what) => new Refusal('manifest_bad', 'adapter manifest', what, 'the manifest needs protocol faultline.explorer/1, adapter, code (hash of the code under test) and input (hash of the inputs)');
  if (!m || m.protocol !== PROTOCOL) throw bad(`protocol is ${JSON.stringify(m?.protocol)}`);
  for (const k of ['adapter', 'code', 'input']) if (typeof m[k] !== 'string' || !m[k]) throw bad(`${k} is missing`);
  return sha256(canonical({ protocol: m.protocol, adapter: m.adapter, code: m.code, input: m.input, version: m.version ?? null }));
}

async function handshake(client, allowUnguarded) {
  const manifest = await client.call('manifest');
  const manifestHash = checkManifest(manifest);
  let guard = 'verified';
  if (manifest.guard?.selftest === true) {
    const st = await client.call('selftest');
    const open = ['network', 'subprocess', 'writes'].filter((k) => st[k] !== true);
    if (open.length) throw new Refusal('guard_open', 'offline guard', `${open.join(', ')} not blocked`, 'the adapter must refuse network, child processes and writes outside its run folder, and answer selftest with all three true');
  } else if (allowUnguarded) guard = 'unverified';
  else throw new Refusal('guard_missing', 'offline guard', `${manifest.adapter} declares no selftest`, 'make the adapter block network, children and outside writes and declare guard.selftest in its manifest, or pass --allow-unguarded (the label is then capped at BOUNDED_INCOMPLETE)');
  return { manifest, manifestHash, guard };
}

/** Run the adapter's known-answer states first. A checker that calls everything stuck, or nothing stuck, never gets to explore. */
async function runControls(client) {
  const res = await client.call('controls');
  const list = res.controls || [];
  const results = [];
  for (const c of list) {
    const got = checkClass(await client.call('classify', { state: c.state }), `control ${c.name}`);
    results.push({ name: c.name, expect: c.expect, got: got.cls, reason: got.reason, ok: got.cls === c.expect });
  }
  const wantStuck = results.filter((r) => r.expect === 'stuck');
  const wantNot = results.filter((r) => r.expect !== 'stuck' && ['ok', 'wait', 'end'].includes(r.expect));
  if (!wantStuck.length || !wantNot.length) {
    throw new Refusal('controls_missing', 'known-answer controls', `${wantStuck.length} expect stuck, ${wantNot.length} expect not stuck`, 'ship at least one control that must be stuck and one that must not be');
  }
  const wrong = results.filter((r) => !r.ok);
  if (wrong.length) {
    const allStuck = wantNot.every((r) => r.got === 'stuck');
    const noneStuck = wantStuck.every((r) => r.got !== 'stuck');
    const why = allStuck ? 'the checker calls everything stuck' : noneStuck ? 'the checker calls nothing stuck' : 'the checker disagrees with known answers';
    throw new Refusal('controls_failed', 'known-answer controls', `${why}: ${wrong.map((r) => `${r.name} expected ${r.expect}, got ${r.got}`).join('; ')}`, 'fix the classify step so every control gets its known answer');
  }
  return results;
}

/** Fresh process, fresh state: apply the recorded actions and demand the same class, reason and identity. */
export async function replayAll(adapter, runDir, manifestHash, specs, allowUnguarded) {
  const client = new AdapterClient({ ...adapter, runDir }).start();
  const results = [];
  try {
    const hs = await handshake(client, allowUnguarded);
    if (hs.manifestHash !== manifestHash) throw new Refusal('manifest_changed', 'replay', 'the adapter manifest differs from the one that found it', 'replay against the same code and inputs');
    const init = (await client.call('initial')).states || [];
    for (const spec of specs) {
      const r = { ok: false, why: '' };
      try {
        let state = init[spec.init];
        if (state === undefined) { r.why = `no initial state ${spec.init}`; results.push(r); continue; }
        if (sha256(identityBuffer(await client.call('identity', { state }))) !== spec.initialIdentity) { r.why = 'the initial state is not the same'; results.push(r); continue; }
        let fine = true;
        for (const a of spec.actions) {
          const ap = await client.call('apply', { state, action: a });
          if (ap.rejected !== undefined || ap.state === undefined) { r.why = `action ${a} was rejected${ap.rejected ? ': ' + ap.rejected : ''}`; fine = false; break; }
          state = ap.state;
        }
        if (fine) {
          const c = checkClass(await client.call('classify', { state }), 'replay');
          const id = sha256(identityBuffer(await client.call('identity', { state })));
          if (c.cls !== spec.expect.class) r.why = `replay ends ${c.cls}, expected ${spec.expect.class}`;
          else if (c.reason !== spec.expect.reason) r.why = `replay reason ${c.reason}, expected ${spec.expect.reason}`;
          else if (id !== spec.expect.identity) r.why = 'replay reaches a different state';
          else r.ok = true;
        }
      } catch (e) { r.why = e.message; }
      results.push(r);
    }
  } finally { await client.close(); }
  return results;
}

function lockRun(runDir) {
  const f = path.join(runDir, '.lock');
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); } catch {
    const owner = Number(fs.readFileSync(f, 'utf8'));
    if (owner && owner !== process.pid && alive(owner)) throw new Refusal('run_busy', 'run folder', `pid ${owner} is using ${runDir}`, 'wait for it to finish or use another --run folder');
    fs.writeFileSync(f, String(process.pid));
  }
  return () => { try { if (Number(fs.readFileSync(f, 'utf8')) === process.pid) fs.unlinkSync(f); } catch { /* gone */ } };
}

const refusalResult = (runDir, e) => {
  try { fs.writeFileSync(path.join(runDir, 'refusal.json'), JSON.stringify(e.refusal, null, 1) + '\n'); } catch { /* run folder unwritable */ }
  return { ok: false, refused: e.refusal, walkPath: null };
};

/**
 * Explore. o: {adapter:{cmd,args}, runDir, out, budgets:{states,evals,seconds}, resume, fresh, store, facts, model,
 *              allowUnguarded, hashFn, maxEnds}
 * Breadth first from the initial states, so the first witness for a finding is a shortest one.
 */
export async function runExplorer(o) {
  const runDir = path.resolve(o.runDir);
  fs.mkdirSync(runDir, { recursive: true });
  const budgets = { ...DEFAULT_BUDGETS, ...(o.budgets || {}) };
  const hashFn = o.hashFn || ((b) => sha256(b));
  const unlock = lockRun(runDir);
  let client = null, store = null;
  try {
    if (o.fresh) for (const f of ['explorer.sqlite', 'explorer.sqlite-wal', 'explorer.sqlite-shm', 'journal.jsonl', 'refusal.json', 'run.json']) fs.rmSync(path.join(runDir, f), { force: true });
    if (existingStore(runDir) && !o.resume) {
      throw new Refusal('run_exists', 'run folder', `${runDir} already holds a run`, 'pass --resume to continue it or --fresh to start over');
    }
    store = await openStore(runDir, o.store || 'auto');
    client = new AdapterClient({ ...o.adapter, runDir, timeoutMs: o.timeoutMs }).start();
    const { manifest, manifestHash, guard } = await handshake(client, o.allowUnguarded);
    const had = store.meta('manifestHash');
    if (had && had !== manifestHash) {
      throw new Refusal('manifest_changed', 'resume', `the code or inputs changed since this run started (${store.meta('manifest')?.adapter ?? '?'})`, 'restore the code and inputs it started with, or rerun with --fresh');
    }
    const controls = await runControls(client);
    const t0 = Date.now();
    const spent0 = store.meta('spentMs') || 0;
    const stats = store.meta('stats') || { evals: 0, rejected: 0, collisions: 0, expanded: 0 };
    if (!had) { store.setMeta('manifestHash', manifestHash); store.setMeta('manifest', manifest); store.setMeta('startedAt', 0); }
    // initial states
    let nStates = store.counts().states;
    if (!nStates) {
      const init = (await client.call('initial')).states || [];
      store.begin();
      for (let i = 0; i < init.length; i++) if (await addState(client, store, hashFn, stats, init[i], { parent: null, action: null, depth: 0, init: i })) nStates++;
      store.commit();
    }
    let stopped = null;
    const spent = () => spent0 + (Date.now() - t0);
    while (true) {
      const row = store.nextOpen();
      if (!row) break;
      if (spent() / 1000 >= budgets.seconds) { stopped = 'seconds'; break; }
      if (stats.evals >= budgets.evals) { stopped = 'evals'; break; }
      if (nStates >= budgets.states) { stopped = 'states'; break; }
      const acts = ((await client.call('actions', { state: JSON.parse(row.state) })).actions || [])
        .map((a) => (typeof a === 'string' ? a : a.id)).sort();
      if (stats.evals + acts.length > budgets.evals) { stopped = 'evals'; break; }
      stats.evals += acts.length;
      const results = await Promise.all(acts.map((a) => client.call('apply', { state: JSON.parse(row.state), action: a })));
      store.begin();
      let blocked = false;
      for (let k = 0; k < acts.length; k++) {
        const ap = results[k];
        if (ap.rejected !== undefined || ap.state === undefined) { stats.rejected++; continue; }
        if (nStates >= budgets.states) { blocked = true; break; }
        if (await addState(client, store, hashFn, stats, ap.state, { parent: row.id, action: acts[k], depth: row.depth + 1, init: row.init })) nStates++;
      }
      if (blocked) { store.commit(); stopped = 'states'; break; }
      store.markExpanded(row.id);
      stats.expanded++;
      store.setMeta('stats', stats);
      store.setMeta('spentMs', spent());
      store.commit();
    }
    store.setMeta('stats', stats);
    store.setMeta('spentMs', spent());
    store.commit?.();
    return await finish({ o, runDir, store, client, manifest, manifestHash, guard, controls, stats, stopped, budgets });
  } catch (e) {
    if (e instanceof Refusal) return refusalResult(runDir, e);
    throw e;
  } finally {
    try { await client?.close(); } catch { /* */ }
    try { store?.close(); } catch { /* */ }
    unlock();
  }
}

/** One new state: identity (hash of the full bytes, compared on collision), class, place. Labels never merge two states. */
async function addState(client, store, hashFn, stats, state, meta) {
  const ident = identityBuffer(await client.call('identity', { state }));
  const hash = hashFn(ident);
  const same = store.lookup(hash);
  if (same.length) {
    if (same.some((r) => Buffer.compare(r.ident, ident) === 0)) return null; // seen: exact bytes agree
    stats.collisions++; // same hash, different bytes: a real collision, keep both
  }
  const [c, w] = await Promise.all([client.call('classify', { state }), client.call('where', { state })]);
  const { cls, reason } = checkClass(c, 'classify');
  const at = typeof w === 'string' ? w : String(w?.at ?? '');
  return store.insert({ hash, ident, state: JSON.stringify(state), parent: meta.parent, action: meta.action, depth: meta.depth, cls, reason, at, init: meta.init, x: !EXPANDS.has(cls) });
}

function pathTo(store, row) {
  const rows = [];
  for (let r = row; r; r = r.parent != null ? store.get(r.parent) : null) rows.unshift(r);
  return rows;
}

async function finish(c) {
  const { o, runDir, store, client, manifest, manifestHash, guard, controls, stats, stopped, budgets } = c;
  await client.close();
  const counts = store.counts();
  const by = counts.byClass;
  const maxEnds = o.maxEnds ?? 10;
  const groups = new Map();
  for (const cls of ['stuck', 'invalid']) for (const r of store.byClass(cls)) {
    const key = [cls, r.at, r.reason].join('|');
    const g = groups.get(key);
    if (g) g.count++; else groups.set(key, { cls, row: r, count: 1 });
  }
  const ends = new Map();
  for (const r of store.byClass('end')) if (!ends.has(r.at) && ends.size < maxEnds) ends.set(r.at, { cls: 'end', row: r, count: 0 });
  for (const r of store.byClass('end')) if (ends.has(r.at)) ends.get(r.at).count++;
  const picked = [...groups.values(), ...ends.values()];
  const specs = picked.map((g) => {
    const p = pathTo(store, g.row);
    g.path = p;
    return { init: g.row.init, initialIdentity: sha256(p[0].ident), actions: p.slice(1).map((r) => r.action),
      expect: { class: g.row.cls, reason: g.row.reason, identity: sha256(g.row.ident) } };
  });
  const replays = specs.length ? await replayAll(o.adapter, runDir, manifestHash, specs, o.allowUnguarded) : [];
  const outDir = path.dirname(path.resolve(o.out || path.join(runDir, 'explorer.walk.jsonl')));
  const outPath = path.resolve(o.out || path.join(runDir, 'explorer.walk.jsonl'));
  const base = path.basename(outPath).replace(/\.walk\.jsonl$/, '').replace(/\.jsonl$/, '');
  const outcomes = [], findings = [], unreplayed = [];
  picked.forEach((g, i) => {
    const rep = replays[i];
    const where = g.row.at;
    const rec = { kind: g.cls, at: where, reason: g.row.reason, states: g.count, actions: specs[i].actions, replayed: rep.ok };
    if (!rep.ok) { unreplayed.push({ ...rec, why: rep.why }); findings.push(rec); return; }
    const wrel = `${base}.witness/${String(outcomes.length + 1).padStart(2, '0')}-${slug(g.cls + '-' + where)}.json`;
    const wfile = path.join(outDir, wrel);
    fs.mkdirSync(path.dirname(wfile), { recursive: true });
    fs.writeFileSync(wfile, JSON.stringify({ kind: 'faultline.witness/1', source: 'explorer', adapter: manifest.adapter, manifestHash, ...specs[i],
      path: g.path.map((r) => ({ action: r.action, at: r.at, class: r.cls })) }, null, 1) + '\n');
    const steps = g.path.filter((r) => r.at).map((r) => ({ ...symOrTag(r.at), ...(r.action ? { action: r.action } : {}) }));
    // an ending with no place cannot name a box: an unplaced end is not evidence of anything, an unplaced stuck state is still a problem
    const head = !where ? (g.cls === 'end' ? null : 'unknown') : g.cls === 'stuck' ? `stuck:${where}` : g.cls === 'end' ? `end:${where}` : 'error';
    if (!head) { findings.push({ ...rec, replayed: true, skipped: 'no place' }); return; }
    outcomes.push({ outcome: head, strength: 'replayable', witness: wrel, count: 1, steps, granularity: 'state', states: g.count,
      reason: `${g.row.reason || g.cls}; shortest witness is ${specs[i].actions.length} action(s); ${g.count} state(s) like it in the search` });
    rec.witness = wrel;
    findings.push(rec);
  });
  const total = counts.states;
  const incomplete = !!stopped || counts.open > 0 || (by.cut || 0) > 0;
  const degenerate = total >= 3 && (by.stuck || 0) === total;
  let label = !total ? 'NONE' : !stats.expanded ? 'SAMPLED' : incomplete ? 'BOUNDED_INCOMPLETE' : 'EXHAUSTIVE_WITHIN_MODEL';
  if (label === 'EXHAUSTIVE_WITHIN_MODEL' && (guard !== 'verified' || unreplayed.length)) label = 'BOUNDED_INCOMPLETE';
  const controlsPassed = controls.every((r) => r.ok) && !degenerate && !unreplayed.length && guard === 'verified';
  const unexplored = [];
  for (const r of store.openAts().slice(0, 50)) unexplored.push({ at: r.at, why: `budget cut: ${stopped || 'states left open'} (${r.n} state(s) not expanded)` });
  const cutAts = new Set(store.byClass('cut').map((r) => r.at));
  for (const at of [...cutAts].sort().slice(0, 50)) unexplored.push({ at, why: 'cut by the adapter\'s own bound' });
  const explored = store.allAts().filter(Boolean);
  const notReached = notReachedBoxes(o.model, explored);
  const hashes = {};
  if (o.facts?.functions) {
    const cited = new Map((o.model?.boxes || []).map((b) => [b.id, (b.refs || []).map((r) => r.symbol)]));
    for (const at of explored) for (const sym of [at, ...(cited.get(at) || [])]) if (o.facts.functions[sym]?.sha256) hashes[sym] = o.facts.functions[sym].sha256;
  }
  const walk = {
    header: { tool: `faultline-explorer@1/${manifest.adapter}`, kind: 'explorer', pin: manifest.code, adapterInput: manifest.input, guard,
      ...(Object.keys(hashes).length ? { hashes } : {}) },
    label: { label, controls_passed: controlsPassed, explored, unexplored, ...(notReached.length ? { notReached } : {}) },
    outcomes,
  };
  writeWalkFile(outPath, walk);
  const result = {
    ok: true, label, controls_passed: controlsPassed, walkPath: outPath, runDir, guard, store: store.kind,
    stats: { states: total, expanded: stats.expanded, open: counts.open, evals: stats.evals, rejected: stats.rejected, collisions: stats.collisions,
      byClass: by, stopped, degenerate },
    controls, findings, unreplayed, notReached, budgets,
  };
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify(result, null, 1) + '\n');
  return result;
}

/** Boxes of the model that no explored place names, directly or through a symbol the box cites. */
function notReachedBoxes(model, explored) {
  if (!model?.boxes) return [];
  const at = new Set(explored);
  return model.boxes.filter((b) => !at.has(b.id) && !(b.refs || []).some((r) => at.has(r.symbol))).map((b) => b.id);
}

/** Replay a witness file against the adapter, in a fresh process. */
export async function replayWitnessFile(file, adapter, runDir, allowUnguarded = false) {
  const w = JSON.parse(fs.readFileSync(file, 'utf8'));
  const [r] = await replayAll(adapter, path.resolve(runDir), w.manifestHash, [w], allowUnguarded);
  return r;
}

const USAGE = `usage: runner.mjs --run DIR [--out FILE] [--max-states N] [--max-evals N] [--max-seconds S] [--resume|--fresh]
                 [--facts FILE] [--model-dir DIR] [--store sqlite|journal] [--allow-unguarded] -- <adapter command...>
       runner.mjs --replay WITNESS.json [--run DIR] -- <adapter command...>`;

export async function main(argv) {
  const dd = argv.indexOf('--');
  const own = dd < 0 ? argv : argv.slice(0, dd);
  const cmd = dd < 0 ? [] : argv.slice(dd + 1);
  const opt = {};
  const flags = new Set(['--resume', '--fresh', '--allow-unguarded', '--json']);
  for (let i = 0; i < own.length; i++) {
    const a = own[i];
    if (flags.has(a)) opt[a.slice(2)] = true;
    else if (a.startsWith('--')) opt[a.slice(2)] = own[++i];
    else { console.error(USAGE); return 2; }
  }
  if (!cmd.length || (!opt.run && !opt.replay)) { console.error(USAGE); return 2; }
  // the adapter runs with its cwd in the run folder, so file arguments are made absolute here
  const abs = (x) => (!x.startsWith('-') && /[\/]/.test(x) && fs.existsSync(x) ? path.resolve(x) : x);
  const adapter = { cmd: abs(cmd[0]), args: cmd.slice(1).map(abs) };
  const runDir = opt.run || path.join(path.dirname(path.resolve(opt.replay)), '.replay-run');
  if (opt.replay) {
    const r = await replayWitnessFile(opt.replay, adapter, runDir, !!opt['allow-unguarded']);
    console.log(r.ok ? 'REPLAYED: the witness reaches the same state and the same verdict' : `NOT REPLAYED: ${r.why}`);
    return r.ok ? 0 : 1;
  }
  let facts = null, model = null;
  if (opt.facts) facts = JSON.parse(fs.readFileSync(opt.facts, 'utf8'));
  if (opt['model-dir']) {
    model = { boxes: [] };
    for (const f of fs.readdirSync(opt['model-dir']).filter((x) => x.endsWith('.json')).sort()) {
      const j = JSON.parse(fs.readFileSync(path.join(opt['model-dir'], f), 'utf8'));
      if (j.boxes) model.boxes.push(...j.boxes);
    }
  }
  const num = (v) => (v == null ? undefined : Number(v));
  const r = await runExplorer({ adapter, runDir, out: opt.out, resume: !!opt.resume, fresh: !!opt.fresh, store: opt.store, facts, model,
    allowUnguarded: !!opt['allow-unguarded'],
    budgets: Object.fromEntries(Object.entries({ states: num(opt['max-states']), evals: num(opt['max-evals']), seconds: num(opt['max-seconds']) }).filter(([, v]) => v !== undefined)) });
  if (opt.json) console.log(JSON.stringify(r));
  if (!r.ok) { console.error(r.refused.msg); return 3; }
  if (!opt.json) {
    console.log(`${r.label}${r.controls_passed ? ' (controls passed)' : ' (controls not passed)'}: ${r.stats.states} states, ${r.stats.expanded} expanded, ${r.stats.evals} evaluations, store ${r.store}`);
    for (const f of r.findings) console.log(`  ${f.kind} at ${f.at || '?'}: ${f.reason} [${f.states} state(s), ${f.actions.length} action(s)] ${f.replayed ? 'replayed' : 'DID NOT REPLAY'}`);
    console.log(`walk: ${r.walkPath}`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e.stack || e.message); process.exitCode = 1; });
}
