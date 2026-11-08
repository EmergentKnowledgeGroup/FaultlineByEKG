// faultline mcp: the six agent commands as MCP tools over stdio. Hand-rolled JSON-RPC 2.0, one JSON message per line, no dependency.
// Tool descriptions are under 40 words each (tested). The map is rebuilt when the model, facts or walks change on disk, so a long
// session never reads a stale view of the project files (the code itself is never looked at). Logs go to stderr only; stdout carries nothing but protocol messages.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { agentView } from '../build/pipeline.mjs';
import { resolveProject } from '../build/project.mjs';
import * as C from './commands.mjs';

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const budgetProp = { budget: { type: 'integer', description: 'Raise the token cap for this answer.' } };
const str = (d) => ({ type: 'string', description: d });

export const TOOLS = [
  { name: 'faultline_brief', description: 'Whole-system brief: what was read and what is open, stages, loops, endings and the top questions. Start here. Ends with a link a person can open.',
    inputSchema: { type: 'object', properties: { ...budgetProp } } },
  { name: 'faultline_where', description: 'Locate a box from a box id, function id, name, file or file:line: its stage, plain sentence, every road in and out with conditions, evidence level and candidates there.',
    inputSchema: { type: 'object', properties: { target: str('Box id, path/file.py:42, path::Class.method, or a name.'), ...budgetProp }, required: ['target'] } },
  { name: 'faultline_breaks', description: 'Candidates and proved breaks with their shape, evidence and one question each. Candidates are suspicions, not confirmed bugs. Optionally limited to one stage.',
    inputSchema: { type: 'object', properties: { stage: str('Stage id to limit to.'), all: { type: 'boolean', description: 'Include lower-ranked candidates.' }, silent: { type: 'boolean', description: 'List only the failure endings the map says nobody is told about (heard by nobody, or only a log).' }, leads: { type: 'boolean', description: 'List the weak shapes (leads) kept out of the candidates.' }, ...budgetProp } } },
  { name: 'faultline_path', description: 'The drawn route between two boxes, with the condition on every hop: along a declared path when both boxes are on one (it says which), else the shortest. Says plainly when no route is drawn.',
    inputSchema: { type: 'object', properties: { from: str('Start box id or anything where resolves.'), to: str('End box id or anything where resolves.'), shortest: { type: 'boolean', description: 'Ignore declared paths; give the shortest road.' }, ...budgetProp }, required: ['from', 'to'] } },
  { name: 'faultline_impact', description: 'Downstream of a box or file by forward roads: counts by hop, boxes within 2 hops, endings within 4, the rest by stage; says where it stops at a shared funnel. Also what feeds it.',
    inputSchema: { type: 'object', properties: { target: str('Box id, file, file:line or symbol.'), ...budgetProp }, required: ['target'] } },
  { name: 'faultline_status', description: 'What was read and what is open on a tool map, or draft or finished on a map written by hand; whether the page matches the stored map (the code is not re-checked); the next step. Cheap.',
    inputSchema: { type: 'object', properties: { ...budgetProp } } },
];

function signature(dir) {
  const parts = [];
  const stat = (p) => { try { const s = fs.statSync(p); parts.push(p + ':' + s.mtimeMs + ':' + s.size); } catch { parts.push(p + ':-'); } };
  for (const f of ['facts.json', 'census.json', 'dismissed.json', 'model.merged.json', path.join('dist', 'atlas.html')]) stat(path.join(dir, f));
  for (const d of ['model', 'walks', 'layout']) { try { for (const f of fs.readdirSync(path.join(dir, d)).sort()) stat(path.join(dir, d, f)); } catch { parts.push(d + ':-'); } }
  return parts.join('|');
}

export function makeServer({ dir, cwd = process.cwd() }) {
  let cache = null;
  const linkBase = path.relative(cwd, path.join(dir, 'dist', 'atlas.html')).split(path.sep).join('/');
  async function current() {
    const sig = signature(dir);
    if (!cache || cache.sig !== sig) cache = { sig, ...(await agentView(dir, {})) };
    return cache.data;
  }
  async function call(name, a = {}) {
    const data = await current(), o = { linkBase, budget: a.budget > 0 ? a.budget : 0 };
    switch (name) {
      case 'faultline_brief': return C.brief(data, o);
      case 'faultline_where': return C.where(data, need(a.target, 'target'), o);
      case 'faultline_breaks': return C.breaks(data, { ...o, stage: a.stage || null, all: !!a.all, leads: !!a.leads, silent: !!a.silent });
      case 'faultline_path': return C.path(data, need(a.from, 'from'), need(a.to, 'to'), { ...o, shortest: !!a.shortest });
      case 'faultline_impact': return C.impact(data, need(a.target, 'target'), o);
      case 'faultline_status': return C.status(data, o);
      default: throw Object.assign(new Error(`Unknown tool ${name}`), { rpc: -32602 });
    }
  }
  const need = (v, k) => { if (v == null || String(v).trim() === '') throw Object.assign(new Error(`Missing argument "${k}".`), { rpc: -32602 }); return String(v); };

  // returns a response object, or null for a notification
  async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return msg && msg.id !== undefined ? { jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'Invalid request' } } : null;
    const { id, method, params = {} } = msg, reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result }), fail = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
    try {
      if (method === 'initialize') {
        const v = VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0];
        return reply({ protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'faultline', version: '0.1.1' },
          instructions: 'Faultline by EKG. Call faultline_brief first; every answer names box ids and ends with a link a person can open.' });
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
      if (method === 'ping') return reply({});
      if (method === 'tools/list') return reply({ tools: TOOLS });
      if (method === 'tools/call') {
        try { return reply({ content: [{ type: 'text', text: await call(params.name, params.arguments || {}) }] }); }
        catch (e) {
          if (e.rpc) return fail(e.rpc, e.message);
          return reply({ isError: true, content: [{ type: 'text', text: `${e.message}${e.cli ? '' : ' (faultline could not read the project; run faultline check in the repo)'}` }] });
        }
      }
      return fail(-32601, `Method not found: ${method}`);
    } catch (e) { return fail(-32603, String(e.message || e)); }
  }
  return { handle, call, current };
}

export async function serve(argv) {
  const i = argv.indexOf('--project'), project = i >= 0 ? argv[i + 1] : undefined;
  const p = resolveProject({ project });
  if (!p.exists) { process.stderr.write('faultline mcp: no project here. Run faultline init in the repo, or pass --project DIR.\n'); return 2; }
  const server = makeServer({ dir: p.dir });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0, closed = false;
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  const done = () => { if (closed && !pending) process.exit(0); };
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    pending++;
    Promise.all((Array.isArray(msg) ? msg : [msg]).map((m) => server.handle(m))).then((rs) => {
      const out = rs.filter(Boolean);
      if (out.length) send(Array.isArray(msg) ? out : out[0]);
    }).finally(() => { pending--; done(); });
  });
  rl.on('close', () => { closed = true; done(); });
  process.stderr.write(`faultline mcp: serving ${p.dir}\n`);
  return new Promise(() => {});          // runs until stdin closes
}
