#!/usr/bin/env node
// Faultline by EKG: command line. One system, one map, two readers. `faultline help` lists the commands.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HELP } from './args.mjs';
import { CliError } from '../src/build/project.mjs';
import { jsonWhere } from '../src/story/canon.mjs';

// Windows looks for a bare program name (python, py, git) in the current folder before PATH. Faultline is often run from inside a repo it did not write,
// so that search is off for every program it starts.
process.env.NoDefaultCurrentDirectoryInExePath = '1';

const LOAD = {
  setup: ['./cmds_map.mjs', 'setup'], map: ['./cmds_map.mjs', 'map'], review: ['./cmds_map.mjs', 'review'], story: ['./cmds_map.mjs', 'story'],
  init: ['./cmds_project.mjs', 'init'], extract: ['./cmds_project.mjs', 'extract'], propose: ['./cmds_project.mjs', 'propose'], check: ['./cmds_project.mjs', 'check'],
  place: ['./cmds_project.mjs', 'place'], build: ['./cmds_project.mjs', 'build'], look: ['./cmds_project.mjs', 'lookCmd'], analyze: ['./cmds_project.mjs', 'analyzeCmd'],
  signals: ['./cmds_scale.mjs', 'signals'], plan: ['./cmds_scale.mjs', 'plan'], parts: ['./cmds_scale.mjs', 'parts'], worklist: ['./cmds_scale.mjs', 'worklist'], join: ['./cmds_scale.mjs', 'join'],
  walk: ['./cmds_evidence.mjs', 'walk'], coverage: ['./cmds_evidence.mjs', 'coverage'], evidence: ['./cmds_evidence.mjs', 'evidence'],
  brief: ['./cmds_agent.mjs', 'brief'], where: ['./cmds_agent.mjs', 'where'], breaks: ['./cmds_agent.mjs', 'breaks'], path: ['./cmds_agent.mjs', 'path_'],
  impact: ['./cmds_agent.mjs', 'impact'], status: ['./cmds_agent.mjs', 'status'], mcp: ['../src/agent/mcp.mjs', 'serve'],
};

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return 0; }       // asking what it does is not a mistake: help, exit 0
  if (cmd === '--version' || cmd === '-v') {
    let v = '?';
    try { v = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { /* a copy without its package.json */ }
    console.log(`faultline ${v} (Faultline by EKG)`);
    return 0;
  }
  const hit = LOAD[cmd];
  if (!hit) { console.error(`faultline: unknown command "${cmd}". Run  faultline help.`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { console.log(HELP); return 0; }
  try {
    const mod = await import(hit[0]);
    const code = await mod[hit[1]](rest);
    return typeof code === 'number' ? code : 0;
  } catch (e) {
    if (e && e.cli) { console.error(`faultline: ${e.message}`); return e.code || 1; }
    // a JSON.parse that nothing handled: V8's message quotes the start of the file, which may be one this run was never meant to show, so it says only that and where (a SyntaxError that is not about JSON keeps its message)
    console.error(`faultline: ${e instanceof SyntaxError && /JSON/.test(e.message) ? `a file is ${jsonWhere(e)}` : e && e.message ? e.message.split('\n')[0] : e}`);
    if (process.env.FAULTLINE_DEBUG) console.error(e && e.stack);
    else console.error('(set FAULTLINE_DEBUG=1 for the stack)');
    return 1;
  }
}

// run when invoked as the program (the npm shim may be a symlink), not when imported by a test
const same = (a, b) => { try { return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase(); } catch { return false; } };
if (process.argv[1] && same(process.argv[1], fileURLToPath(import.meta.url))) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
