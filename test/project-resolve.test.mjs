// Where a project is looked for, where the tools are kept, and that the tests run in a home of their own.
import { testHome } from './lib/sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveProject } from '../src/build/project.mjs';
import { defaultToolsDir, toolsBase, oldToolsNote } from '../src/map/tools.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'faultline.mjs');
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const mk = (...parts) => { const d = path.join(...parts); fs.mkdirSync(d, { recursive: true }); return d; };
const put = (file, text = '{}\n') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const noTools = () => { const e = { ...process.env }; delete e.FAULTLINE_TOOLS; return e; };
const cli = (args, cwd) => { const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: noTools() }); return { code: r.status, out: r.stdout || '', err: r.stderr || '' }; };

test('the tests run in a home of their own', () => {
  assert.ok(testHome && fs.existsSync(testHome), 'the sandbox made a folder');
  assert.ok(same(os.homedir(), testHome), `os.homedir() is ${os.homedir()}, the sandbox is ${testHome}`);
  assert.ok(same(process.env.USERPROFILE, testHome) && same(process.env.HOME, testHome));
  assert.ok(same(path.dirname(path.dirname(process.env.LOCALAPPDATA)), testHome));
  if (!process.env.FAULTLINE_TOOLS) assert.ok(same(toolsBase().slice(0, testHome.length), testHome), `the default tool cache ${toolsBase()} is inside the sandbox`);
});

test('the tool cache: per-user cache folders, FAULTLINE_TOOLS first', () => {
  const home = path.join(path.sep, 'h', 'ann');
  assert.equal(defaultToolsDir({}, 'win32', home), path.join(home, 'AppData', 'Local', 'faultline', 'tools'));
  assert.equal(defaultToolsDir({ LOCALAPPDATA: 'D:\\cache' }, 'win32', home), path.join('D:\\cache', 'faultline', 'tools'));
  assert.equal(defaultToolsDir({}, 'linux', home), path.join(home, '.cache', 'faultline', 'tools'));
  assert.equal(defaultToolsDir({ XDG_CACHE_HOME: '/x/cache' }, 'linux', home), path.join('/x/cache', 'faultline', 'tools'));
  assert.equal(defaultToolsDir({ XDG_CACHE_HOME: '/x/cache' }, 'darwin', home), path.join('/x/cache', 'faultline', 'tools'));
  assert.equal(defaultToolsDir({ FAULTLINE_TOOLS: '/elsewhere', LOCALAPPDATA: 'D:\\cache' }, 'win32', home), '/elsewhere');
  assert.ok(!/\.faultline/.test(defaultToolsDir({}, 'win32', home) + defaultToolsDir({}, 'linux', home)), 'the cache is not a .faultline folder');
});

test('a .faultline folder in the home folder is never the project, whatever is in it', () => {
  const stash = process.env.FAULTLINE_TOOLS; delete process.env.FAULTLINE_TOOLS;
  try {
    const fl = mk(testHome, '.faultline');
    put(path.join(fl, 'config.json'), '{"include":[],"exclude":[]}\n');
    put(path.join(fl, 'facts.json')); put(path.join(fl, 'census.json'));
    put(path.join(fl, 'model', '00-system.json'), '{"schema":"faultline.model/1"}\n');
    const below = mk(testHome, 'work', 'repo', 'src');
    for (const cwd of [below, testHome]) {
      const p = resolveProject({ cwd });
      assert.equal(p.exists, false, cwd); assert.equal(p.fresh, true);
      assert.ok(same(p.dir, path.join(cwd, '.faultline')), `a new project goes beside ${cwd}, got ${p.dir}`);
    }
    assert.ok(same(resolveProject({ cwd: below, project: fl }).dir, fl), '--project can still name it');
    assert.equal(resolveProject({ cwd: fl }).exists, false, 'standing inside it does not adopt it either');
  } finally {
    fs.rmSync(path.join(testHome, '.faultline'), { recursive: true, force: true });
    fs.rmSync(path.join(testHome, 'work'), { recursive: true, force: true });
    if (stash !== undefined) process.env.FAULTLINE_TOOLS = stash;
  }
});

test('a .faultline folder counts only if it looks like a project: tools alone do not', () => {
  const repo = mk(testHome, 'proj-a');
  try {
    const sub = mk(repo, 'pkg', 'deep');
    put(path.join(repo, '.faultline', 'tools', 'ty-0.1', 'bin', 'ty'), 'x');
    let p = resolveProject({ cwd: sub });
    assert.equal(p.exists, false, 'a folder holding only tools is not a project'); assert.ok(same(p.dir, path.join(sub, '.faultline')));
    put(path.join(repo, '.faultline', 'map', 'model.json'));
    p = resolveProject({ cwd: sub });
    assert.equal(p.exists, true); assert.ok(same(p.dir, path.join(repo, '.faultline')), 'a tool map is found from a folder below it');
    assert.ok(same(p.root, repo));
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('what makes a .faultline folder a project: facts, census, config, a model fragment, a map or a built page', () => {
  const base = mk(testHome, 'proj-b');
  try {
    const kinds = {
      facts: (d) => put(path.join(d, 'facts.json')),
      config: (d) => put(path.join(d, 'config.json')),
      fragment: (d) => put(path.join(d, 'model', '00-system.json'), '{"schema":"faultline.model/1"}\n'),
      map: (d) => put(path.join(d, 'map', 'model.json')),
      page: (d) => put(path.join(d, 'dist', 'atlas.agent.json')),
    };
    let i = 0;
    for (const [name, make] of Object.entries(kinds)) {
      const repo = mk(base, `r${i++}`); make(path.join(repo, '.faultline'));
      assert.equal(resolveProject({ cwd: mk(repo, 'x') }).exists, true, name);
    }
    const bare = mk(base, 'bare', '.faultline');
    assert.equal(resolveProject({ cwd: path.dirname(bare) }).exists, false, 'an empty .faultline is not a project');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('old tools in ~/.faultline/tools: one line, only when they are there and not the folder in use', () => {
  const stash = process.env.FAULTLINE_TOOLS; delete process.env.FAULTLINE_TOOLS;
  try {
    assert.equal(oldToolsNote(), null, 'nothing there, nothing said');
    put(path.join(testHome, '.faultline', 'tools', 'ty-0.0.1', 'bin', 'ty'), 'x');
    const line = oldToolsNote();
    assert.match(line, /^note: tools from an older setup are in /); assert.equal(line.split('\n').length, 1);
    assert.match(line, /faultline setup/);
    assert.equal(oldToolsNote(path.join(testHome, '.faultline', 'tools')), null, 'if that folder is the one in use it is not "old"');
    // it must not make the home folder a project, and a command below it still says there is no project
    const cwd = mk(testHome, 'w');
    const r = cli(['brief'], cwd);
    assert.equal(r.code, 2); assert.match(r.err, /No project here/);
    const st = cli(['setup', '--status'], cwd);
    assert.equal(st.code, 3); assert.match(st.out, /not installed/); assert.match(st.out, /note: tools from an older setup/);
    fs.rmSync(cwd, { recursive: true, force: true });
  } finally {
    fs.rmSync(path.join(testHome, '.faultline'), { recursive: true, force: true });
    if (stash !== undefined) process.env.FAULTLINE_TOOLS = stash;
  }
});
