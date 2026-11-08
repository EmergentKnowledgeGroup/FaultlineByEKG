import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPython } from '../src/map/pyread.mjs';
import { requireRecentPython, headerEnv, MIN_PYTHON } from '../src/map/pyenv.mjs';
import { loadState, checkFresh } from '../src/map/state.mjs';
import { findFiles, fileDigest, StaleInput } from '../src/map/files.mjs';
import { tmpTree, python, hasPython } from './lib/map-util.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SRC = {
  'shop/__init__.py': '',
  'shop/cart.py': [
    'import json',
    'from .pricing import total_of',
    '',
    'class Cart:',
    '    def __init__(self, items):',
    '        self.items = items',
    '',
    '    def checkout(self):',
    '        try:',
    '            return total_of(self.items)',
    '        except KeyError as err:',
    '            print(err)',
    '            raise',
    '        finally:',
    '            json.dumps({})',
    '',
    'def helper(x):',
    '    return x',
    'def helper(x):',
    '    return x + 1',
  ].join('\n'),
  'shop/pricing.py': 'def total_of(items):\n    return sum(i for i in items)\n',
  'shop/broken.py': 'def oops(:\n',
};

test('the Python reader refuses a Python that is too old, and says which', () => {
  assert.throws(() => requireRecentPython({ exe: 'old-python', version: [3, MIN_PYTHON[1] - 1, 0] }), /3\.10 or newer.*old-python is 3\.9\.0/);
  assert.throws(() => requireRecentPython(null), /no Python interpreter found/);
  assert.doesNotThrow(() => requireRecentPython({ exe: 'x', version: [3, 10, 0] }));
});

test('the header environment is the version and a digest of the installed packages, never a path', () => {
  const a = headerEnv({ version: [3, 12, 4], prefix: 'C:/somewhere', dists: ['a==1', 'b==2'] });
  assert.deepEqual(Object.keys(a).sort(), ['count', 'packages', 'version']);
  assert.equal(a.version, '3.12');
  assert.notEqual(a.packages, headerEnv({ version: [3, 12, 4], prefix: 'C:/elsewhere', dists: ['a==1', 'b==3'] }).packages);
  assert.equal(a.packages, headerEnv({ version: [3, 12, 9], prefix: 'D:/x', dists: ['a==1', 'b==2'] }).packages);
});

test('the Python reader: graphs, classes, imports, name facts, unreadable files', { skip: !hasPython && 'no Python 3.10 or newer' }, async () => {
  const root = tmpTree(SRC);
  const files = findFiles(root, [], [], ['.py']);
  const { ir, order } = await readPython({ root, files, python });
  assert.equal(ir.schema, 'fldet.pyir/1');
  assert.deepEqual(ir.errors.map((e) => e[0]), ['shop/broken.py']);
  const cart = ir.files.find((f) => f.path === 'shop/cart.py');
  assert.equal(cart.module, 'shop.cart');
  assert.deepEqual(cart.imports.total_of, ['name', 'shop.pricing', 'total_of']);
  assert.deepEqual(cart.imports.json, ['mod', 'json']);
  assert.deepEqual(cart.classes.map((c) => [c.name, Object.keys(c.methods)]), [['Cart', ['__init__', 'checkout']]]);
  const ids = cart.fns.map((f) => f.id);
  assert.ok(ids.includes('shop/cart.py::helper') && ids.includes('shop/cart.py::helper~2'), 'a second definition of a name gets its own id');
  const co = cart.fns.find((f) => f.qual === 'Cart.checkout');
  const kinds = co.nodes.map((n) => n.k);
  for (const k of ['entry', 'exit', 'xexit', 'disp', 'handler', 'final', 'return', 'raise']) assert.ok(kinds.includes(k), k);
  const call = co.nodes.flatMap((n) => n.ops || []).find((o) => o.t === 'call' && o.f === 'total_of');
  assert.ok(Number.isInteger(call.nl) && Number.isInteger(call.nc), 'a call carries where its callee name starts');
  const handler = co.nodes.find((n) => n.k === 'handler');
  assert.deepEqual([handler.types, handler.var, handler.uses], [['KeyError'], 'err', 1]);
  assert.ok(ir.facts.names.includes('total_of') && ir.facts.names.includes('dumps'));
  assert.ok(order.fns.indexOf('shop/cart.py::helper') < order.fns.indexOf('shop/cart.py::helper~2'));
  assert.deepEqual(order.clsByName.Cart, ['shop.cart:Cart']);
});

test('a project loaded from the reader answers lookups, and refuses sources that changed', { skip: !hasPython && 'no Python 3.10 or newer' }, async () => {
  const root = tmpTree(SRC);
  const files = findFiles(root, [], [], ['.py']);
  const { ir, order } = await readPython({ root, files, python });
  const P = loadState({ root, ir: { py: ir, ts: null, lua: null }, order: { py: order }, ty: null, sourceDigest: null, sourceFiles: 0 });
  assert.equal(P.modname.get('shop.cart'), 'shop/cart.py');
  assert.equal(P.classes.get('shop.cart:Cart').methods.checkout, 'shop/cart.py::Cart.checkout');
  assert.deepEqual(P.methodsByName.get('checkout'), ['shop/cart.py::Cart.checkout']);
  assert.equal(P.modfn.get('shop/pricing.py\u0000total_of'), 'shop/pricing.py::total_of');
  assert.ok(P.strs instanceof Set && P.errors.length === 1);
  assert.throws(() => loadState({ root, ir: { py: null, ts: { files: [{ path: 'shop/cart.py', classes: [], fns: [], imports: {} }], source_digest: 'not the digest' }, lua: null }, order: {}, ty: null }), StaleInput);
  fs.writeFileSync(path.join(root, 'shop', 'pricing.py'), 'def total_of(items):\n    return 0\n');
});

test('the Python reader says so when the interpreter cannot be run', async () => {
  await assert.rejects(readPython({ root: tmpTree(), files: [], python: { exe: 'definitely-not-a-python-1234', version: [3, 12, 0] } }), /Python reader failed|ENOENT/);
});
