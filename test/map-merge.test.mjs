import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../src/map/state.mjs';
import { resolveClass, mro, findMethod, subclassesDefining, own } from '../src/map/classes.mjs';
import { indexDefs, resolverPass, setPythonAnswers, roadTargets, effectsOf } from '../src/map/resolvemix.mjs';
import { tkey } from '../src/map/canon.mjs';

/** A small project: pkg/base.py has Base.run, pkg/impl.py has Impl(Base).run and a free function `go`; the checker's answers are given by the test. */
function project() {
  const P = emptyState('/r');
  const fn = (id, path, qual, line, ncol, cls = null) => ({ id, path, qual, line, ncol, cls, lang: 'py', nodes: [] });
  const add = (f) => P.fns.set(f.id, f);
  add(fn('pkg/base.py::Base.run', 'pkg/base.py', 'Base.run', 3, 8, 'pkg.base:Base'));
  add(fn('pkg/impl.py::Impl.run', 'pkg/impl.py', 'Impl.run', 5, 8, 'pkg.impl:Impl'));
  add(fn('pkg/impl.py::go', 'pkg/impl.py', 'go', 9, 4));
  add(fn('pkg/impl.py::<module>', 'pkg/impl.py', '<module>', 1, undefined));
  P.classes.set('pkg.base:Base', { name: 'Base', mod: 'pkg/base.py', bases: [], methods: { run: 'pkg/base.py::Base.run', toString: 'pkg/base.py::Base.toString' }, attrs: {}, line: 2, ncol: 6 });
  P.classes.set('pkg.impl:Impl', { name: 'Impl', mod: 'pkg/impl.py', bases: ['Base'], methods: { run: 'pkg/impl.py::Impl.run' }, attrs: {}, line: 4, ncol: 6 });
  P.clsByName.set('Base', ['pkg.base:Base']);
  P.clsByName.set('Impl', ['pkg.impl:Impl']);
  P.mods.set('pkg/base.py', { name: 'pkg.base', imports: {}, lang: 'py', lines: 5 });
  P.mods.set('pkg/impl.py', { name: 'pkg.impl', imports: { Base: ['name', 'pkg.base', 'Base'] }, lang: 'py', lines: 10 });
  P.modname.set('pkg.base', 'pkg/base.py');
  P.modname.set('pkg.impl', 'pkg/impl.py');
  P.modfn.set(tkey('pkg/impl.py', 'go'), 'pkg/impl.py::go');
  P.resolvers.ts = null;
  indexDefs(P);
  return P;
}
const caller = { id: 'pkg/x.py::f', path: 'pkg/x.py', qual: 'f' };
const site = (o) => ({ t: 'call', f: 'x.run', nl: 7, nc: 4, ...o });

test('class lookups: imports decide what a name means, a method called toString is not the object built-in', () => {
  const P = project();
  assert.equal(resolveClass(P, 'Base', 'pkg/impl.py'), 'pkg.base:Base');
  assert.equal(resolveClass(P, 'Missing', 'pkg/impl.py'), null);
  assert.deepEqual(mro(P, 'pkg.impl:Impl'), ['pkg.impl:Impl', 'pkg.base:Base']);
  assert.equal(findMethod(P, 'pkg.impl:Impl', 'run'), 'pkg/impl.py::Impl.run');
  assert.equal(findMethod(P, 'pkg.impl:Impl', 'toString'), 'pkg/base.py::Base.toString');
  assert.equal(findMethod(P, 'pkg.impl:Impl', 'valueOf'), null);
  assert.equal(findMethod(P, 'pkg.impl:Impl', 'constructor'), null);
  assert.deepEqual(subclassesDefining(P, 'pkg.base:Base', 'run'), ['pkg/impl.py::Impl.run']);
  assert.equal(own({ a: 1 }, 'toString'), undefined);
});

test('no checker: the lexical answer stays, nothing is claimed', () => {
  const P = project();
  const o = site({ how: 'exact', to: ['pkg/impl.py::go'] });
  assert.deepEqual(resolverPass(P, caller, o, 'py'), ['none', []]);
  assert.deepEqual(o, site({ how: 'exact', to: ['pkg/impl.py::go'] }));
});

test('a checker that agrees confirms the road; one that disagrees wins and the lexical target is kept as a veto', () => {
  const P = project();
  setPythonAnswers(P, { version: 'ty 1', env: { ty: 'ty 1' }, answers: { 'pkg/x.py:7:4': [{ k: 'proj', p: 'pkg/impl.py', l: 9, c: 4 }], 'pkg/x.py:8:4': [{ k: 'proj', p: 'pkg/impl.py', l: 9, c: 4 }] } });
  const agree = site({ how: 'exact', to: ['pkg/impl.py::go'] });
  assert.deepEqual(resolverPass(P, caller, agree, 'py'), ['project', []]);
  assert.deepEqual([agree.to, agree.may, agree.how], [['pkg/impl.py::go'], [], 'exact']);
  const clash = site({ nl: 8, how: 'exact', to: ['pkg/base.py::Base.run'], own: 'pkg/base.py::Base.run' });
  assert.deepEqual(resolverPass(P, caller, clash, 'py'), ['project', []]);
  assert.deepEqual([clash.to, clash.veto, clash.how, clash.own], [['pkg/impl.py::go'], ['pkg/base.py::Base.run'], 'typed', undefined]);
  assert.deepEqual(P.rstat, { agree: 1, conflict: 1, conflict_py: 1 });
});

test('a typed receiver whose method is overridden gets the overrides as possible targets', () => {
  const P = project();
  setPythonAnswers(P, { version: 'ty 1', env: {}, answers: { 'pkg/x.py:7:4': [{ k: 'proj', p: 'pkg/base.py', l: 3, c: 8 }] } });
  const o = site({});
  resolverPass(P, caller, o, 'py');
  assert.deepEqual([o.to, o.may, o.how], [['pkg/base.py::Base.run', 'pkg/impl.py::Impl.run'], ['pkg/base.py::Base.run', 'pkg/impl.py::Impl.run'], 'typed']);
  assert.deepEqual(roadTargets(o), [[], o.to], 'every target is only possible');
});

test('outside definitions, variables, silence and missing answers', () => {
  const P = project();
  setPythonAnswers(P, { version: 'ty 1', env: {}, answers: {
    'pkg/x.py:1:0': [{ k: 'ext', m: 'os', q: 'getcwd' }, { k: 'ext', m: 'os', q: 'getcwd' }], 'pkg/x.py:2:0': [{ k: 'proj', p: 'pkg/x.py', l: 1, c: 0 }], 'pkg/x.py:3:0': [], 'pkg/x.py:4:0': null,
  } });
  const run = (nl, extra) => { const o = site({ nl, nc: 0, ...extra }); return [resolverPass(P, caller, o, 'py'), o]; };
  assert.deepEqual(run(1, { how: 'by-name', cand: ['pkg/impl.py::go'] })[0], ['ext', [['os', 'getcwd']]]);
  assert.equal(run(1, { how: 'by-name', cand: ['pkg/impl.py::go'] })[1].how, 'ext');
  const [dyn, od] = run(2, { how: 'exact', to: ['pkg/impl.py::go'] });
  assert.deepEqual([dyn, od.how, od.to], [['dynamic', []], 'dynamic', undefined], 'an answer that is not a def or class is a variable: the lexical road goes');
  const [sil, os] = run(3, { how: 'exact', to: ['pkg/impl.py::go'] });
  assert.deepEqual([sil, os.may], [['silent', []], ['pkg/impl.py::go']], 'the checker said nothing: the lexical road is only a maybe');
  assert.deepEqual(run(4, {})[0], ['silent', []]);
  assert.equal(P.rstat.lexical_unconfirmed, 1);
});

test('TypeScript: the checker answer inside the call is merged the same way', () => {
  const P = project();
  P.resolvers.ts = 'tsc 5';
  P.fns.set('a.ts::f', { id: 'a.ts::f' });
  P.fns.set('a.ts::g', { id: 'a.ts::g' });
  const one = { t: 'call', f: 'g', r: { k: 'project', to: ['a.ts::g'], may: [], cand: ['a.ts::f', 'missing'], x: [] } };
  assert.deepEqual(resolverPass(P, caller, one, 'ts'), ['project', []]);
  assert.deepEqual([one.to, one.may, one.how, one.cand], [['a.ts::g'], [], 'typed', ['a.ts::f']]);
  const two = { t: 'call', f: 'g', how: 'exact', to: ['a.ts::f'], r: { k: 'project', to: ['a.ts::f', 'a.ts::g'], may: [] } };
  resolverPass(P, caller, two, 'ts');
  assert.deepEqual([two.to, two.may], [['a.ts::f', 'a.ts::g'], ['a.ts::f', 'a.ts::g']], 'two proven targets are only possible ones');
  const ext = { t: 'call', f: 'f.send', r: { k: 'ext', x: [['node:fs', 'fs.writeFileSync']] } };
  assert.deepEqual(resolverPass(P, caller, ext, 'ts'), ['ext', [['node:fs', 'fs.writeFileSync']]]);
  assert.deepEqual(resolverPass(P, caller, { t: 'call', f: 'zz' }, 'lua'), ['none', []]);
});

test('effectsOf: a project callee adds nothing, an unknown outside callee is maybe:call, a lock context is lockwith', () => {
  const efx = {
    classifyCall: () => new Set(), lexicalDefs: () => [], decide: () => [new Set(), new Set()], adjust: (k, m) => [k, m], boundaryOf: () => [new Set(), new Set()],
    isPure: () => false, SQL_WRITE: /^\s*(insert|update)/i,
  };
  const P = project();
  const proj = { t: 'call', f: 'go', to: ['pkg/impl.py::go'] };
  effectsOf(P, proj, new Map(), 'project', [], [], new Set(), null, efx);
  assert.equal(proj.eff, undefined);
  const out = { t: 'call', f: 'other.thing' };
  effectsOf(P, out, new Map(), 'ext', [['other', 'thing']], [], new Set(), null, efx);
  assert.deepEqual(out.eff, ['maybe:call']);
  const lock = { t: 'with', f: 'self._lock' };
  effectsOf(P, lock, new Map(), 'silent', [], [], new Set(), null, efx);
  assert.deepEqual(lock.eff, ['lockwith']);
});
