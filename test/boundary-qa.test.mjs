// Gaps the QA pass found after the boundary fix: Windows trailing dots and spaces, a project folder holding links, programs found in the current folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RootedSource } from '../src/story/source.mjs';
import { resolveProject } from '../src/build/project.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fl-bqa-'));

test('a path part that ends in a dot or a space is refused (Windows would open a different name than the one checked)', () => {
  const src = new RootedSource(tmp());
  for (const p of ['link.py.', 'link.py ', 'pkg./a.py', 'pkg /a.py']) assert.equal(src.ref(p).ok, false, p);
  for (const p of ['a.py', 'pkg/a.py', '.hidden/a.py']) assert.equal(src.ref(p).ok, true, p);
});

test('a project folder that holds a link is refused before anything is read or written', (t) => {
  const home = tmp(), outside = tmp();
  const proj = path.join(home, 'repo', '.faultline');
  fs.mkdirSync(path.join(proj, 'map'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'facts.json'), '{}');
  try { fs.symlinkSync(path.join(outside, 'target.json'), path.join(proj, 'map', 'model.json'), 'file'); } catch (e) { t.skip(`links cannot be made here (${e.code})`); return; }
  assert.throws(() => resolveProject({ project: proj }), /holds a link \(map\/model\.json\)/);
  fs.unlinkSync(path.join(proj, 'map', 'model.json'));
  assert.equal(resolveProject({ project: proj }).dir, proj, 'the same folder without the link is fine');
});

test('a project root that is not text is ignored, not a crash', () => {
  const proj = path.join(tmp(), '.faultline');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'config.json'), '{"root":["x"]}');
  assert.equal(resolveProject({ project: proj }).rootFrom, 'guess');
});

test('the command line turns off the Windows search of the current folder for programs it starts', async () => {
  await import('../bin/faultline.mjs');
  assert.equal(process.env.NoDefaultCurrentDirectoryInExePath, '1');
});
