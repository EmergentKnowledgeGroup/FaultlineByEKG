// Tiny argument parser and the help text. No dependency. Unknown flags are an error with a hint, never silently ignored.
import { CliError } from '../src/build/project.mjs';

const GLOBAL_STR = ['project', 'root'];
const GLOBAL_BOOL = ['help', 'json'];

// spec: {str:[names], bool:[names], rep:[names]}  ->  {pos:[...], o:{name:value|true}}   (a rep option may be given again and again: its value is a list)
export function parse(argv, spec = {}) {
  const str = new Set([...GLOBAL_STR, ...(spec.str || [])]), bool = new Set([...GLOBAL_BOOL, ...(spec.bool || [])]), rep = new Set(spec.rep || []);
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('--') || a === '-') { pos.push(a); continue; }
    let [k, v] = a.slice(2).split(/=(.*)/s);
    if (bool.has(k)) { o[k] = true; continue; }
    if (str.has(k) || rep.has(k)) {
      if (v === undefined) { v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new CliError(`--${k} needs a value.`, 2); }
      if (rep.has(k)) (o[k] ??= []).push(v); else o[k] = v;
      continue;
    }
    throw new CliError(`Unknown option --${k}. Try  faultline help.`, 2);
  }
  return { pos, o };
}

export const HELP = `Faultline by EKG: one system, one map, two readers.
A person gets an interactive atlas. An agent gets a small text view of the same map. Both use the same box ids.

There are two layers.
  Layer 1, the tool map: "faultline map" reads the code and draws a true map and a readable page. No agent, no key, nothing to write by hand.
  Layer 2, the story: an agent (or you) writes a map in words, the long way further down, and "faultline story" checks it against Layer 1.

Usage: faultline <command> [options]      (run from the repo, from inside .faultline, or pass --project DIR: the project folder, or the folder that holds .faultline)
A path with a space in it needs quotes:  faultline map --source "my code"

Start here: the tool map, in one command
  setup                      once, if the code has Python: fetches the pinned Python type checker (ty), checks its hash, keeps it in your cache folder
                             (Windows %LOCALAPPDATA%/faultline/tools; elsewhere $XDG_CACHE_HOME/faultline/tools or ~/.cache/faultline/tools; FAULTLINE_TOOLS names another)
                             (without it the map is still made, but says nothing negative about Python and leaves Python effects as "maybe")   [--dir D] [--status]
  map --source DIR           code to a finished page in one run: read, apply the rules, scan, write the reading, place the charts, build the page.
                             A few seconds for a small system, minutes for a large one. Prints each stage, then the times, then the page:
                             .faultline/dist/atlas.html. Python files need Python 3.10 or newer; TypeScript, JavaScript and Lua come with npm install.
                             What could not be read is said in a "note:" line, and the rest is still mapped.
                             The same code with the same checker gives the same bytes. The code is only read: the project goes in ./.faultline unless --project says otherwise.
                             [--project DIR  where the project goes (default ./.faultline; a folder that already holds a .faultline project means that project)] [--name TEXT] [--no-page  stop before placing and building]
                             [--python GLOB ...] [--python-exclude GLOB ...] [--typescript PREFIX] [--ts-exclude PREFIX ...] [--tsconfig FILE] [--lua PREFIX]
                             [--config FILE] [--tools DIR] [--interpreter EXE] [--work DIR] [--quiet]
                             Without a language flag every language found is read, except what is not part of the system and is left out by default:
                             dependencies, build output, caches, virtual environments, vendored and generated code, test and fixture folders, and the
                             documentation folders at the top of the source folder (docs, doc, documentation, website, docs_src). A "note:" line names the
                             documentation folders that held code. To map one, give it as the source:  faultline map --source docs
                             It writes <project>/map/ (model.json claims.json calls.json review-index.json
                             story-index.json), <project>/read/ (the reading) and the page project. Give it a folder of its own: it does not mix with a map
                             an agent wrote by hand.
  brief, where, breaks, path, impact, status    (listed below) work on that project at once, a few hundred tokens each.

Review: what the tool is not sure of, for an agent to look into
  review queue               the not-confident claims as questions, main path first   [--limit N] [--out FILE]
  review check --answers F   re-check an agent's answers against the source. An answer only annotates a claim: it cannot add or remove a box or a road
  review view                the claims as a reader sees them, with the checked answers beside them   [--without-agent] [--out FILE]
                             all three take [--map DIR] [--source DIR]. A map whose code changed after it was written is refused.

Story: an agent's map in words, checked against the tool map
  story check --story F      each box and road of the story gets a verdict: joined by the tool at the cited line, joined by a route, related, or no link
                             (never "proven"). Writes <project>/story/check.json   [--out F] [--allow-stale]
  story apply --words F      put an agent's titles and sentences on the tool map's own boxes. Words only: a box or a road in it is refused   [--out F] [--report F]
  story page                 copy the story's page and add the overlay: marks, counts, a switch, and the tool's words on hover   [--check F] [--page F] [--out F]

The long way: an agent writes the map by hand (init, extract, propose, write model/, check, place, build)
  These belong to a project of their own. On a project that faultline map made, extract, propose, check, place, analyze, signals, plan, parts, worklist and join
  refuse and name the command to use instead.
Build the map
  init                       make .faultline/ with a starter model
  extract                    read the code: facts, census, graph (and signals) [--include a,b] [--exclude c,d] [--no-defaults]
  signals                    read the code again for pairs (pause/resume), flags set but never cleared, messages handled but never sent, empty
                             handlers and swallowed errors; writes signals.json (extract writes it too)   [--out DIR]
  propose                    where to look: route hints from the call graph (each with its call site file:line and the box that holds it), gaps, hotspots
                             prints a count line, then the top 40 hints, islands first   [--stage ID] [--cross-stage] [--into-islands] [--limit N] [--offset N] [--json]
                             --into-islands keeps only hints into a box with no road in, and lists the direct callers of the ones no hint reaches
  check [--finished]         run the gates. Draft prints gaps, --finished refuses on them. Prints the count per code; receipts.json lists every offender
        [--stage ID]         judge only that stage's boxes, routes, loops and ledger rows and print ALL its offenders. Another stage's refusal is
                             counted on one line ("other stages have N refusals") and never stops it
  place [chart ...]          lay out every chart (cached)               [--force] [--seed N] [--budget SECONDS] [--stage ID] [--tiled|--classic] [--prune]
                             the whole map of a big system (over 120 boxes or 220 routes) is composed from the placed stage parts in seconds; --tiled forces that, --classic the old placer
                             prints [n/total] and seconds per chart. --budget is counted work; the ceiling is 6 x the planned router passes, never the clock, so a busy machine gives the same layout: a chart
                             that reaches it keeps its best layout so far and is reported as CAPPED. --stage places that stage's chart parts, and
                             works while another stage's fragment is refused (it then reads only that stage's fragments plus 00-*)
  build [--draft|--finished] write .faultline/dist/atlas.html, atlas.agent.json, BRIEF.md   [--no-place] [--excerpts] [--keep-messages] [--source-base URL]
                             on a project that faultline map made, build rebuilds its page the same way map did (the Reader included), from the map already there; it reads no code
                             and takes neither --draft nor --finished. To read the code again, run faultline map.
                             --draft or --no-place still builds when charts have no layout: they are listed as not drawn. --finished refuses
                             imported log text (an outcome's reason) stays out of the page and the agent file; --keep-messages puts it in. Paths are always repo-relative
  look [chart ...]           PNGs drawn from the saved layouts, no build needed   [--stage ID] [--width N --height N]
                             --page shoots the built page instead (needs faultline build)  [--ev]
  analyze                    list candidates, 10 shown by default ("10 of 171 shown"; kept suspects take at most 5 of them)   [--all] [--full] [--stage ID]
                             --all lists every candidate, one line each (--full: every field); --stage keeps the candidates in that stage [--dismiss KEY --why TEXT [--by NAME]] [--keep KEY --why TEXT [--by NAME]]
                             answers are kept in dismissed.json, one entry per key (--by defaults to "agent"):
                               dismissed   {"<key>": {"why": "one sentence", "by": "name", "at": "YYYY-MM-DD"}}
                               suspect     {"<key>": {"suspect": true, "why": "one sentence", "by": "name", "at": "YYYY-MM-DD"}}   (stays listed, marked as kept)
                             an entry with an empty "why" does nothing: a candidate is resolved by a reason, never by silence.
                             A dismissal has to answer the question the candidate asks: "one function, same arguments" does not say what each caller has
                             finished, and "the loop re-checks" does not say what wakes it. An entry whose key no longer fires stays in the file and is
                             counted as an orphan, not an error. A lead (swallowed-error) is a weak shape: not a candidate, not counted by gate A1, listed by --all
                             (analyze) and by  breaks --leads

Mapping a large system with several agents
  plan                       one line per stage from stageplan.json: rows left, boxes, modules nobody owns
  parts [--stage ID]         every chart part of a split stage: its name and where the name came from, the functions it holds, its first boxes, and the names that
                             mislead (a name used by two parts, given to boxes in several, two names in one part). check warns the same as W-part-name
  worklist <stage>           one stage's modules, doors, switches, loops, census rows still to draw, and its hand-offs checked without writing
                             anything: "hand-offs: N ok, M would not resolve" (from box exists, function exists, line inside it, where it would land)
  join                       handoffs/*.json become routes between stages; what cannot resolve is listed (handoffs.unresolved.json). A hand-off lands on
                             the box whose first ref (or full-name handle) is the function: its ENTRY first (no road in from another box that cites it), then
                             non-ending, then lowest cited line; a generic handle counts only when that box's first ref is in the same file. Later-ref landings,
                             ties and roads onto another stage's ending (not when the row names a box with "to") are listed in handoffs.review.json.
                             A RETURN (type "return") lands on the box that CALLS INTO the
                             returning box's flow (a forward road into it, or into a box it can be reached from; the fewest hops; an exact toLine first), not on the
                             function's entry; each says how it landed in handoffs.review.json, and the ones with no caller found are questions. Running join twice writes the
                             same files. Re-pointing a hand-off can change route ids: do not re-join audited maps without diffing 80-handoffs.json

Evidence
  walk add FILE              add a .walk.jsonl (from any tool) to the map; a cleaned copy is stored (no machine paths, emails or secrets)
  walk list                  what the loaded walks say
  coverage import FILE       turn a coverage report (coverage.py, lcov, istanbul) into a walk    [--format F] [--strip-prefix P]
  evidence <sub> ...         logs, statechart and explorer imports (see src/evidence/cli.mjs)

For an agent (each answer is under a token budget and ends with a link to open)
  brief                      the whole system in about 1200 tokens
  where <what>               which box, its roads in and out. <what> is a box id (f58.0, or the long id from map/model.json), a function id (path/file.py::Class.method),
                             a bare function name (Class.method or method), file or file:line, or words from a box title. A function with no box of its own is answered as a function.
  breaks [--stage s] [--all] [--leads] [--silent]  on a tool map: the same ranked questions the page's Where it can break lists, with the same counts, as many as fit the cap.
                             On a map written by hand: candidates and proved breaks, one question each; kept suspects take at most 5 of the 10 slots; --leads lists the weak shapes; --silent lists the failure endings nobody is told about
                             (the first few are always shown after the candidates)
  path <a> <b>               the route between two boxes: along a declared path when both are on one (it says which), else a route the roads allow (each road 1, a change of stage 6, a main-path road far less)   [--shortest: fewest hops]
  impact <box|file>          what is downstream by forward roads: counts by hop, boxes within 2 hops, endings within 4; stops at shared funnels and says so
  status                     on a tool map: what was read, what is open, whether the page matches the map (by content, not file time) and what to do next.
                             On a map written by hand: draft or finished (FINISHED only when the gates pass and the page is built and current), gaps, charts not placed
  mcp                        serve the six above over MCP stdio (JSON-RPC, no dependency)
  Any of them takes --budget TOKENS to raise the cap.

Options everywhere: --project DIR   --root DIR (the source folder)   --help
`;
