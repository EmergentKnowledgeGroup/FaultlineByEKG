// The honesty lane of the file-boundary fix: what status, the MCP tool, the pin label, the README and the version say must match what the tool does.
//   node --test test/boundary-honesty.test.mjs
import './lib/sandbox.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { statusLines, pinSaid } from '../src/agent/toolmap.mjs';
import { TOOLS, makeServer } from '../src/agent/mcp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// the least a tool map's status needs: the reading's numbers, no notes
const nums = { functions: 12, files: 3, languages: { py: 3 }, boxes: 9, roads: 11, stages: 2, claims: 20, claimsNotConfident: 0, noBoxes: 0, unresolved: 0, severalTargets: 0, questions: 0, questionsSure: 0, gaps: 0, hearerUnknown: 0, failing: 0 };
const data = (pin) => ({ pin, toolMap: { nums, notes: [] }, findings: [] });
const page = (o) => ({ built: true, current: true, recorded: true, changed: '', ...o });

test('status says the page matches the stored map and that the code was not checked', () => {
  const lines = statusLines(data('tree abcdef0123'), page());
  const said = lines.filter((l) => /matches the map/.test(l));
  assert.equal(said.length, 1);
  assert.match(said[0], /^page: built, matches the map as stored \(code not checked\)$/);
  for (const l of statusLines(data(''), page({ current: false, recorded: false }))) assert.doesNotMatch(l, /cannot tell if current/);
  assert.match(statusLines(data(''), page({ current: false, changed: 'model/x.json changed' })).join('\n'), /page: OUT OF DATE \(model\/x\.json changed\)/);
});

test('a git pin is labelled as where HEAD was; a tree pin and no pin are left as they were', () => {
  assert.match(pinSaid('git 0123456789'), /^git 0123456789 \(HEAD; the files read may hold uncommitted edits\)$/);
  assert.equal(pinSaid('tree 0123456789'), 'tree 0123456789');
  assert.equal(pinSaid(''), '');
  assert.equal(pinSaid(undefined), '');
  assert.match(statusLines(data('git 0123456789'), page())[0], /pin git 0123456789 \(HEAD; .*uncommitted edits\)/);
  assert.equal(statusLines(data('tree 0123456789'), page())[0], 'STATUS TOOL MAP  pin tree 0123456789  read from the code; no agent, nothing run');
});

test('the MCP status tool says the code is not re-checked, in under 40 words; the server reports the package version', async () => {
  const t = TOOLS.find((x) => x.name === 'faultline_status');
  assert.match(t.description, /matches the stored map \(the code is not re-checked\)/);
  assert.doesNotMatch(t.description, /before trusting/);
  for (const x of TOOLS) assert.ok(x.description.split(/\s+/).length < 40, `${x.name} is ${x.description.split(/\s+/).length} words`);
  const r = await makeServer({ dir: os.tmpdir() }).handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(r.result.serverInfo.version, JSON.parse(read('package.json')).version);
});

test('the version is 0.1.1 in package.json and at the top of package-lock.json', () => {
  const pkg = JSON.parse(read('package.json')), lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '0.1.1');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('the README has no unfilled placeholder, and it and SECURITY.md say how to report a problem without an email', () => {
  for (const f of ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'docs/GUIDE.md', 'docs/CONTRACTS.md', 'skills/faultline/SKILL.md']) assert.doesNotMatch(read(f), /\{\{\s*[a-z_]+\s*\}\}/i, f);
  const readme = read('README.md'), sec = read('SECURITY.md');
  assert.match(readme, /## Limits and safety/);
  assert.match(readme, /SECURITY\.md/);
  for (const [name, text] of [['README.md', readme], ['SECURITY.md', sec]]) assert.match(text, /github\.com\/EmergentKnowledgeGroup\/FaultlineByEKG\/issues/, name);
  assert.doesNotMatch(sec, /\S+@\S+\.\S+/, 'no email address');
  assert.match(sec, /untrusted input/);
  assert.match(sec, /skipped/);
});

test('the docs call the digest a drift check, say it misses added files, and tell the reader to map a clone themselves', () => {
  for (const f of ['docs/CONTRACTS.md', 'docs/GUIDE.md', 'skills/faultline/references/review.md']) {
    const t = read(f);
    assert.match(t, /added since is not noticed/, f);
    assert.match(t, /run `(faultline )?map` yourself|run `faultline map` yourself/i, f);
  }
  assert.match(read('docs/CONTRACTS.md'), /drift check, not a lock/);
  assert.match(read('docs/CONTRACTS.md'), /does not show that a map folder someone else gave you is honest/);
  assert.doesNotMatch(read('skills/faultline/references/reading-a-map.md'), /refuse a map whose code changed/);
});
