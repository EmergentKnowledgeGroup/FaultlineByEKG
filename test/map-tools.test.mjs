import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readZip, fetchChecked, resolverEnv, platformKey, pins, tyBinary, toolsBase } from '../src/map/tools.mjs';
import { tmpTree } from './lib/map-util.mjs';

/** A zip file with the given entries { name: text }, each stored or deflated. */
function makeZip(entries, deflate) {
  const parts = [], central = [];
  let off = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text), nm = Buffer.from(name), crc = zlib.crc32(raw);
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(deflate ? 8 : 0, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nm.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(deflate ? 8 : 0, 10); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, nm, data);
    central.push(c, nm);
    off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

test('readZip reads stored and deflated entries and checks their checksums', () => {
  for (const deflate of [false, true]) {
    const z = readZip(makeZip({ 'pkg/a.txt': 'hello hello hello', 'pkg/scripts/tool': 'binary' }, deflate));
    assert.deepEqual(z.map((e) => e.name), ['pkg/a.txt', 'pkg/scripts/tool']);
    assert.equal(z[0].data().toString(), 'hello hello hello');
  }
  const bad = makeZip({ 'x': 'abc' }, false);
  bad[bad.indexOf('abc')] = 0x7a;                            // flip one byte of the content
  assert.throws(() => readZip(bad)[0].data(), /checksum mismatch/);
  assert.throws(() => readZip(Buffer.from('not a zip file at all, just text')), /not a zip/);
});

test('fetchChecked returns the bytes only when their sha256 is the pinned one', async () => {
  const body = Buffer.from('the pinned bytes');
  const srv = http.createServer((req, res) => { if (req.url === '/missing') { res.statusCode = 404; res.end(); } else res.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const sha = createHash('sha256').update(body).digest('hex');
    assert.deepEqual(await fetchChecked(base + '/w.whl', sha, 'w.whl'), body);
    await assert.rejects(fetchChecked(base + '/w.whl', '0'.repeat(64), 'w.whl'), /sha256 mismatch for w\.whl: got [0-9a-f]{64}, pinned 0{64}/);
    await assert.rejects(fetchChecked(base + '/missing', sha), /HTTP 404/);
  } finally { srv.close(); }
});

test('the pin names a wheel with a sha256 for every platform it lists, and this platform has one', () => {
  const p = pins();
  for (const [k, w] of Object.entries(p.wheels)) assert.match(w.sha256, /^[0-9a-f]{64}$/, k);
  assert.ok(p.wheels[platformKey()], platformKey());
});

test('the checker runs with every cache folder pointed at ours and no virtual environment', () => {
  process.env.VIRTUAL_ENV = 'somewhere';
  const e = resolverEnv('/our/cache');
  for (const k of ['LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME', 'TMP', 'TEMP', 'TMPDIR', 'HOME', 'USERPROFILE']) assert.equal(e[k], '/our/cache', k);
  assert.equal(e.VIRTUAL_ENV, undefined);
  delete process.env.VIRTUAL_ENV;
});

test('the tool folder must be absolute, and an empty one has no checker', () => {
  assert.throws(() => toolsBase('relative/tools'), /must be an absolute path/);
  assert.equal(tyBinary(tmpTree()), null);
});
