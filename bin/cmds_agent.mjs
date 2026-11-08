// Commands for an agent: brief where breaks path impact status mcp. Each prints text under its token budget and ends with a deep link.
import path from 'node:path';
import { agentView } from '../src/build/pipeline.mjs';
import { CliError } from '../src/build/project.mjs';
import { ACCEPTED } from '../src/agent/view.mjs';
import * as C from '../src/agent/commands.mjs';
import { loadReading } from '../src/agent/reading.mjs';
import { parse } from './args.mjs';
import { proj, needProject, refreshCommand } from './cmds_project.mjs';

const rel = (p) => path.relative(process.cwd(), p).split(path.sep).join('/');

export async function view(o) {
  const p = proj(o);
  needProject(p);
  const { data, state } = await agentView(p.dir, {});
  const linkBase = rel(path.join(p.dir, 'dist', 'atlas.html'));
  const reading = data.toolMap ? loadReading(p.dir, { facts: state.facts }) : null;    // every function the scan found, the call list and the drawn bodies
  return { data, linkBase, dir: p.dir, root: p.root, rootKnown: p.rootKnown, reading };
}
/** A command asked about something the map does not have exits 1, so a script can tell. The answer says so on its first line: `WHERE <what>: <why>` where a match reads `WHERE <what> -> <box>`. */
const NO_MATCH = { where: (text, q) => text.startsWith(`WHERE ${q}: `), impact: (text, q) => text.startsWith(`IMPACT ${q}: `), path: (text) => /^PATH: .* matches no box/.test(text) };
const exitFor = (verb, text, q) => (NO_MATCH[verb](text, q) ? 1 : 0);
const opts = (o, v) => ({ budget: o.budget ? +o.budget : 0, linkBase: o['link-base'] || v.linkBase, refresh: refreshCommand(v), reading: v.reading });

export async function brief(argv) {
  const { o } = parse(argv, { str: ['budget', 'link-base'] });
  const v = await view(o);
  console.log(o.json ? JSON.stringify(v.data) : C.brief(v.data, opts(o, v)));
  return 0;
}
export async function where(argv) {
  const { pos, o } = parse(argv, { str: ['budget', 'link-base'] });
  if (!pos.length) throw new CliError(`Usage: faultline where <what>
  what: ${ACCEPTED}`, 2);
  const v = await view(o);
  const text = C.where(v.data, pos.join(' '), opts(o, v));
  console.log(text);
  return exitFor('where', text, pos.join(' '));
}
export async function breaks(argv) {
  const { o } = parse(argv, { str: ['budget', 'link-base', 'stage'], bool: ['all', 'leads', 'silent'] });
  const v = await view(o);
  console.log(C.breaks(v.data, { ...opts(o, v), stage: o.stage || null, all: !!o.all, leads: !!o.leads, silent: !!o.silent }));
  return 0;
}
export async function path_(argv) {
  const { pos, o } = parse(argv, { str: ['budget', 'link-base'], bool: ['shortest'] });
  if (pos.length !== 2) throw new CliError('Usage: faultline path <a> <b>   (each is anything  faultline where  accepts: a box id, a function id, a name, file:line)', 2);
  const v = await view(o);
  const text = C.path(v.data, pos[0], pos[1], { ...opts(o, v), shortest: !!o.shortest });
  console.log(text);
  return exitFor('path', text);
}
export async function impact(argv) {
  const { pos, o } = parse(argv, { str: ['budget', 'link-base'] });
  if (!pos.length) throw new CliError(`Usage: faultline impact <what>
  what: ${ACCEPTED}`, 2);
  const v = await view(o);
  const text = C.impact(v.data, pos.join(' '), opts(o, v));
  console.log(text);
  return exitFor('impact', text, pos.join(' '));
}
export async function status(argv) {
  const { o } = parse(argv, { str: ['budget', 'link-base'] });
  const v = await view(o);
  console.log(C.status(v.data, opts(o, v)));
  return 0;
}
