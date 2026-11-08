// The link rules: connections that are not calls, drawn only where both ends are anchored on an exact literal. Fixtures: links_demo (a TypeScript
// dispatcher and four Lua scripts, an emitter and a listener on one class) and http_demo (a Python server, a JavaScript client).
import { needs as needsOf } from './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, build } from './lib/map-helpers.mjs';
import { normPath } from '../src/map/links_http.mjs';
import { readRouteFacts } from '../src/map/routefacts.mjs';
import { FIX, WORK } from './lib/map-helpers.mjs';

const cap = await capabilities();
const needs = (...what) => needsOf(cap, ...what);
const rows = (b, kind) => b.res.links.rows.filter((r) => r.kind === kind);
const q = (fid) => fid.split('::').pop();
const pairs = (b, kind) => rows(b, kind).map((r) => [q(r.from), q(r.to)]).sort((x, y) => (x[0] < y[0] ? -1 : 1));

test('a script is linked by name only from a call that the data shows is a dispatcher', needs('typescript', 'lua'), async () => {
  const b = await build('links_demo', { ts: true, lua: true });
  assert.deepEqual(pairs(b, 'script-by-name'), [['cancel', '<module>'], ['inspect', '<module>'], ['issue', '<module>'], ['seal', '<module>']]);
  const to = Object.fromEntries(rows(b, 'script-by-name').map((r) => [q(r.from), r.to]));
  assert.deepEqual(to, { issue: 'src/commands/mint-1.lua::<module>', seal: 'src/commands/stamp-1.lua::<module>', cancel: 'src/commands/void-2.lua::<module>', inspect: 'src/commands/audit-1.lua::<module>' });
  const d = b.res.links.summary().dispatchers;
  assert.deepEqual(d.map((x) => [q(x.callee), x.accepted]), [['runCommand', true], ['trace', false]]);
  assert.ok(b.res.links.open.some((o) => o.why.includes('not a script dispatcher') && o.detail.includes("'mint'")), 'the decoy that shares a script name is refused and kept in the open ends');
  for (const r of rows(b, 'script-by-name')) assert.equal(r.tier, 'linked');
});

test('an event is linked when both receivers are the same project class and the listener is an inline function', needs('typescript'), async () => {
  const b = await build('links_demo', { ts: true, lua: true });
  const r = rows(b, 'emit-on');
  assert.equal(r.length, 1);
  assert.equal(q(r[0].from), 'press');
  assert.match(q(r[0].to), /^arm\.<anon@\d+>$/);
  assert.equal(r[0].when, "emits 'ring'");
  assert.equal(r[0].anchors.from.literal, 'ring');
});

test('a client path is linked to the server route that handles exactly that path', needs('python', 'typescript'), async () => {
  const b = await build('http_demo', { py: true, ts: true });
  const r = rows(b, 'http-route');
  assert.deepEqual(r.map((x) => [q(x.from), q(x.to), x.to_line]).sort(), [['loadItems', 'Handler.do_GET', 8], ['ping', 'Handler.do_GET', 10], ['things', 'Service.list_things', null]]);
  assert.ok(b.res.links.open.some((o) => o.why === 'literal path is not a route of the server' && o.detail === "'/api/missing'"));
  const st = b.res.links.summary().http;
  assert.equal(st.table_class, 'Service');
  assert.deepEqual(st.server_routes_by_kind, { arm: 2, table: 3 });
});

test('a link is a road of tier linked, and only a link whose ends are plain is confident', needs('python', 'typescript'), async () => {
  const b = await build('http_demo', { py: true, ts: true });
  const roads = b.res.model.routes.filter((x) => x.prov.rule === 'link');
  assert.ok(roads.length >= 2 && roads.every((x) => x.prov.tier === 'linked'));
  const cl = b.res.claims.filter((c) => c.type === 'link-road');
  assert.ok(cl.some((c) => c.conf === 'confident' && c.reason === 'linked-by-literal'));
  assert.ok(cl.every((c) => c.conf === 'confident' || c.reason.startsWith('link-')));
});

test('paths are normalised before they are compared with a route', () => {
  assert.equal(normPath('http://host:8080/api/x?y=1#z'), '/api/x');
  assert.equal(normPath('/api/x?y=1'), '/api/x');
  assert.equal(normPath('/a'), null, 'too short to name one route');
  assert.equal(normPath('/api/${id}'), null, 'a computed path');
  assert.equal(normPath('api/x'), null);
  assert.equal(normPath(5), null);
});

test('the route facts of a Python server are read with the standard library', needs('python'), async () => {
  const f = await readRouteFacts({ root: `${FIX}/http_demo`, rels: ['server/app.py', 'server/table.py'], work: WORK });
  const app = f.files.find((x) => x.path === 'server/app.py');
  assert.deepEqual(app.fns.map((x) => [x.line, x.dverb, x.arms.map((a) => [a.v, a.line])]), [[6, 'GET', [['/api/items', 8], ['/api/health', 10]]]]);
  const table = f.files.find((x) => x.path === 'server/table.py');
  assert.deepEqual(table.tables.map((t) => [t[0], t[1], t[3]]), [['/v1/things', ['list_things'], 'GET'], ['/v1/thing', ['read_thing'], 'GET'], ['/v1/gone', ['drop_thing'], 'GET']]);
});
