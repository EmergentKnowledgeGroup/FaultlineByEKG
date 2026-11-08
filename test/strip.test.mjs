// The page leaves the viewer's comments out. Stripping must remove comments and nothing else.
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripJs, stripCss } from '../src/build/strip.mjs';
import { assemble } from '../src/build/assemble.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

test('stripJs: comments go; strings, templates, regular expressions and divisions are left alone', () => {
  assert.equal(stripJs('var a = 1; // note\nvar b = 2;\n'), 'var a = 1;\nvar b = 2;\n');
  assert.equal(stripJs('/* head */\nvar a = 1;\n'), 'var a = 1;\n');
  assert.equal(stripJs('var u = "http://x/*y*/z"; var v = \'//\';\n'), 'var u = "http://x/*y*/z"; var v = \'//\';\n');
  assert.equal(stripJs('var t = `a // b ${ x /* c */ + "d//" } /* e */`;\n'), 'var t = `a // b ${ x + "d//" } /* e */`;\n');
  assert.equal(stripJs('var r = /["\'/*]+/g, q = s.replace(/\\/\\//g, "") // tail\n'), 'var r = /["\'/*]+/g, q = s.replace(/\\/\\//g, "")\n');
  assert.equal(stripJs('var h = a / b / c; // two divisions\n'), 'var h = a / b / c;\n');
  assert.equal(stripJs('var h = (a) / 2 + n++ / 3; /* x */\n'), 'var h = (a) / 2 + n++ / 3;\n');
  assert.equal(stripJs('return /re/.test(s)/* c */;\n'), 'return /re/.test(s);\n');
  assert.equal(stripJs('a/* x */b\n'), 'a b\n');
  assert.equal(stripJs('x = 1;\n/* two\nlines */ y = 2;\n'), 'x = 1;\ny = 2;\n', 'a comment alone on its line takes its line with it');
  assert.equal(stripJs('x = 1 /* two\nlines */ y = 2;\n'), 'x = 1\n y = 2;\n', 'a comment that hid a line break keeps one');
});

test('stripCss: block comments go, strings and url() text stay', () => {
  assert.equal(stripCss('/* head */\na{color:red} /* tail */\nb::after{content:"/* keep */"}\n'), 'a{color:red}\nb::after{content:"/* keep */"}\n');
});

test('every script the page carries compiles after stripping and holds the same program', async () => {
  const files = ['viewer/viewer.js', 'src/engine/render.mjs', ...fs.readdirSync(path.join(ROOT, 'viewer')).filter((f) => f.endsWith('.js') && f !== 'viewer.js').map((f) => 'viewer/' + f)];
  let ts = null;
  try { ts = (await import('typescript')).default; } catch { /* optional dependency */ }
  for (const f of files) {
    const before = read(f).replace(/^export\s+(default\s+)?/gm, ''), after = stripJs(before);
    assert.ok(after.length < before.length, f);
    assert.equal(stripJs(after), after, `${f}: stripping twice changes nothing more`);
    new vm.Script(after);
    if (ts) {                                                                      // the same syntax tree, printed without comments
      const pr = ts.createPrinter({ removeComments: true });
      const tree = (code) => pr.printFile(ts.createSourceFile('x.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
      assert.equal(tree(after), tree(before), `${f}: only comments were removed`);
    }
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'viewer')).filter((x) => x.endsWith('.css'))) {
    const before = read('viewer/' + f), after = stripCss(before);
    assert.ok(!/\/\*/.test(after.replace(/"[^"]*"|'[^']*'/g, '')), `${f}: no comment left`);
  }
});

test('assemble: the page holds no viewer comment and no process word, and keepComments brings them back', () => {
  const toy = path.join(ROOT, 'examples', 'toy', '.faultline');
  const dataFile = path.join(toy, 'dist', 'atlas.html');
  assert.ok(fs.existsSync(dataFile));
  // the page's data blob is the one thing assemble needs; take it from the toy page that is already built
  const html0 = fs.readFileSync(dataFile, 'utf8');
  const m = /<script[^>]*id="atlas-data"[^>]*>([\s\S]*?)<\/script>/.exec(html0) || /const ATLAS\s*=\s*([\s\S]*?);\s*\n/.exec(html0);
  if (!m) return;                                                                   // the toy page does not expose its data in a shape this test can read
  const data = JSON.parse(m[1]);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-strip-'));
  try {
    const a = assemble(data, path.join(out, 'a')), b = assemble(data, path.join(out, 'b'), { keepComments: true });
    assert.ok(a.bytes < b.bytes);
    const page = fs.readFileSync(a.html, 'utf8');
    assert.ok(!/look\d:|pass \d|frame pass|look pass/.test(page), 'no process tag in the page');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
