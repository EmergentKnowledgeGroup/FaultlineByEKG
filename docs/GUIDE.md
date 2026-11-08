# Faultline guide

**Faultline by EKG.** One system, one map, two readers.

Point Faultline at a codebase and it draws what the code does as one map: boxes for what happens, roads for what leads to what, each road labelled with the condition that sends flow along it. A person gets an interactive page to zoom, hover and click. An agent gets a small text view of the same map.

The map is made by programs, not by a model. It shows where the code could stop, loop or fail, as questions to look into. A question is a candidate, never a verdict, and nothing is run: the map is read from the code.

## Two layers

- **The tool map.** `faultline map --source <folder>` reads the code and writes a true map and a readable page. No agent, no key, no model, nothing to write by hand. Every box and road comes from the code. Where the tool is not sure, the box or road is drawn dashed with a "?", and says why.
- **The story.** An optional second layer. An agent (or a person) writes what the code is for, in words, and `faultline story` checks that writing against the tool map. It says which of the story's boxes and roads the tool finds at the lines they cite, and it carries the words through marked "words, not checked". It never says "proven".

## Quick start

```
npm install
node bin/faultline.mjs setup                          # once, only if the code has Python
node bin/faultline.mjs map --source examples/toy      # the code to a finished page
```

Then open `.faultline/dist/atlas.html` in a browser. It is one file with no server and no network. The toy (`examples/toy`) is an invented parcel job runner with Python and TypeScript in it. For your own code, put its folder after `--source`. The map and the page are written to `.faultline/` in the folder you run the command from; `--project DIR` puts them elsewhere. The code itself is only read.

Then ask for the small text view, from the same folder:

```
node bin/faultline.mjs brief
```

On the toy, the first run takes about 12 seconds on the machine it was tested on, and about 5 seconds when run again into the same folder. Larger code takes longer; no other size has been measured for this text.

## What you get

- **A page** (`dist/atlas.html`) that opens on the Reader: what the code is (its own README or comments, quoted with their source, or a plain statement that none was found), what was read, what was not read, what is open, then the journeys. A journey is one run from an outside trigger such as a command line, a route or a worker, and it can be walked step by step across charts.
- **An overview poster** of the stages and the groups of endings (success, failure, refusal, neutral), and **a chart for each function worth a picture.** Boxes are decisions, loops, waits, stores, endings and steps. Roads carry the condition. Hover or click a box and its roads light up. Stages are sorted by name; the tool does not claim an order in which they run.
- **Where it can break** and **How it fails**, two pages in the top bar. The first lists the questions the reading raised, most useful first. The second lists every failure and refusal ending and says who hears about it, or says "not known from the code".
- **Stages**, **trace between two functions** (where the call path breaks is marked), **off by default** (what sits behind a switch) and **endings**.
- **A text view for agents** (`brief`, `where`, `breaks`, `path`, `impact`, `status`), each under a fixed token cap and ending with a link a person can open.
- **The files behind it**, all readable JSON: every claim the tool made and why (`map/claims.json`), every call and how it was resolved (`map/calls.json`), the exact first and last line of every function (`map/story-index.json`).

## What it is sure of, and what it flags

Every statement the map makes is a claim with a reason: what kind of box this is, that this call reaches that function, that nobody catches this error, who hears about this failure. A claim is **confident** when a type checker, the control-flow graph or a definition table decided it and nothing is left open behind it. It is **not confident** when the tool wrote its label but the evidence is thinner than the words: a name that matched, several functions a call may reach, a caller the tool cannot see (a callback, a decorator, a name built as a string), or a call that looks like it stores, sends or waits but whose definition is not known.

The tool does not guess those. It writes "maybe" or asks. On the toy: 431 claims, 414 confident, 17 not, which group into a handful of questions. Without the Python checker the same toy has 320 claims and 39 not confident, so install it (`faultline setup`).

Not-confident boxes and roads are drawn dashed with a "?", and the Details panel gives the reason in a sentence. A claim that the checker or the flow graph decided is pinned: no review answer and no story can change it.

## What a tool cannot tell you

A program can read what the code does. It cannot read what the code is for. It does not know what matters, what success means, or why a retry or a wait exists. The page therefore says "read from the code" and never invents a purpose: it quotes the project's own words with their source, or says none was found. A candidate such as a loop with no limit shown is a question for someone who knows the intent.

That is what the story is for. An agent reads the cited lines and writes the part the code cannot say: which boxes matter, what each is for, why this loop repeats. Faultline checks the story's boxes and roads against the tool map and marks every word it did not check.

## How an agent helps

An agent works on the questions, not on the map. It cannot add or remove a box or a road on the tool map.

- **`faultline review`** answers the not-confident questions. `review queue` lists each one: a single question, the lines to read, and a closed list of answers. The agent answers with a choice, a `file:line` and a quote from that line. `review check` re-reads the file and marks each answer checked, cited only, opinion, no answer or refused. `review view` shows the claims with the checked answers beside them. An answer only annotates a claim; it never changes one.
- **`faultline story`** writes the story. `story apply` puts an agent's titles and one-sentence descriptions on the tool map's own boxes. It takes words only: a box, a road or any other field in it is refused. `story check` takes a story written as a map. Each road gets "joined by the tool at this line", "joined by a route", "related in the code" or "no link found". Each box gets "in a tool box", "real code, no tool box", "partly found" or "not found". `story page` adds the result to the page.

The rules an agent follows are in `skills/faultline/SKILL.md`.

```
node bin/faultline.mjs review queue --source examples/toy --limit 5
node bin/faultline.mjs story check --story examples/toy/.faultline/model --source examples/toy
```

The second command treats the toy's hand-written map as a story and checks it against the tool map. `review check --answers FILE` takes the agent's answers (the format is in `skills/faultline/references/review.md`). Review and story commands need `--source` with the folder you gave to `map`. They read only inside that folder and skip links that leave it. They refuse if a file the map read has changed since (a file added since is not noticed, so run `map` again after adding code). Run `map` yourself on any repo you cloned before you trust its `.faultline` folder.

## The text view

| Command | Answers | Cap (tokens) |
|---|---|---|
| `faultline brief` | what the code is, what was read and what is open, stages, loops, endings, the top questions | 1200 |
| `faultline where <box id, function id, name, file:line or words from a title>` | which box, its roads in and out with conditions | 400 |
| `faultline breaks [--stage s] [--all] [--silent]` | the ranked questions, one each (on a tool map the same list as the page) | 800 |
| `faultline path <a> <b>` | a route the roads allow, with its conditions (`--shortest` for fewest hops) | 300 |
| `faultline impact <box or file>` | what is downstream, which endings are reachable | 500 |
| `faultline status` | what was read, what is open, whether the page matches the stored map, whether the code still matches it, what to do next | 200 |

The cap is characters divided by four. `--budget N` raises it for one answer. `faultline mcp` serves the same six over MCP stdio. On a tool map `where`, `path` and `impact` take a box id (the page's `f58.0`, or the long id from `map/model.json` that `review` and `story` print), a function id (`path/file.py::Class.method`), a bare function name, `file` or `file:line`, or words from a box title. `brief` and `breaks` list the same ranked questions as the page's "Where it can break", with the same counts, as many as fit the cap.

## Languages and setup

| Reads | Needs | Notes |
|---|---|---|
| Python (`.py`) | Python 3.10 or newer, and the checker `ty` from `faultline setup` | Without Python the run says so on a "note:" line and maps the rest. Without `ty` it maps Python but flags more. `--interpreter EXE` or `FAULTLINE_PYTHON` names the Python. |
| TypeScript and JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | Nothing more: the compiler comes with `npm install` | Uses a `tsconfig.json` if the code has one. |
| Lua (`.lua`) | The Lua grammar, an optional dependency | Without it Lua files are not read, and the run says so. |

Node 24 or newer. Size on the test machine: `npm install` adds about 44 MB in `node_modules` (`npm install --omit=optional` about 29 MB, without the Lua grammar and the screenshot library), and `faultline setup` adds about 46 MB in your cache folder (`%LOCALAPPDATA%/faultline/tools` on Windows, `$XDG_CACHE_HOME/faultline/tools` or `~/.cache/faultline/tools` elsewhere; `FAULTLINE_TOOLS` names another). An older setup kept the checker in `~/.faultline/tools`: `setup` says so in one line when it finds it there, and so does `map` when the checker is not in the new place yet; the old folder can be deleted. The package itself is 4.9 MB unpacked. Everything runs offline after that, except `setup`, which downloads one file and checks its hash.

To read only part of the code, list folders in `.faultline/config.json` (`{"include": ["src/**"], "exclude": []}`), or pass `--python GLOB`, `--typescript PREFIX` or `--lua PREFIX`. Tests, dependency, build and version-control folders are not read.

**What it was tested on:** Windows 10 with Node 24.13.0 and Python 3.13. Nothing has been run on Linux or macOS, or on other Node or Python versions, so treat those as unknown.

## Same bytes

The same code, the same tool commit, the same tool versions (the TypeScript compiler, `ty`) and the same Python environment give the same bytes in every file `map` writes. `map/model.json` says which: the Python version and a digest of its installed packages, and the checker versions. The pin is in `facts.json`, the page and `BRIEF.md`: the git commit HEAD pointed at, and a `tree` hash of the bytes read. The files are read as they lie, so edits not yet committed are in the map but not in that commit; the `tree` hash is the one that follows them. Running the toy twice, into two folders, gave identical files.

## Limits

- It reads code. It does not run it. A candidate is a shape worth a question, and many will turn out to be fine.
- Calls it cannot follow are flagged, not guessed: callbacks, decorators, dynamic names, and library calls with no known definition.
- The stages are groups of folders sorted by name. The tool does not claim an order in which they run.
- A main path is named only when the project's own examples name an entry or one journey clearly dominates. Otherwise the page says "No main path found".
- A page stays under about 16 MB, so on a large codebase not every function gets a chart. The rest are in the Reader as outlines.
- `faultline build` on a tool map's project folder rebuilds the page from the map and reading already there, the Reader included. It reads no code (except with `--excerpts`, which copies today's source lines in under the old drawing), so to see changed code run `faultline map` again. The commands of the hand-written way (`extract`, `propose`, `check`, `place`, `analyze`, `signals`, `plan`, `parts`, `worklist`, `join`) refuse on a tool map's project and name the command to use.
- The map is the code as it was when `map` last ran. `status` checks the page against the stored map and compares the files the map read with the code now (changed, added, missing; `map/sources.json`): it says when the map is behind and does not update it. `review` and `story check` compare a digest of the files the map read: they notice a changed file and miss an added one. The README, docs and package files that the purpose and glossary come from, and `config.json`, are not in the digest, and a file edited while `map` runs can give a map that mixes versions. A digest kept in a map folder someone else made proves nothing about that folder. Run `faultline map` yourself on any repo you cloned before you trust its `.faultline` folder.
- A function the reading drew no box for (it only calls other functions, or was not reduced) cannot be found by name; `status` counts them.
- Only Windows has been tested.

## A map written by hand

Before `faultline map`, a map was written by an agent or a person: boxes and roads in `model/*.json`, checked against the code, then placed and built. That still works, and it is how a full story is written. A project made by `map` and a project written by hand must not share a folder; `map` refuses.

```
faultline init                 # makes .faultline/ with a starter model
faultline extract              # reads the code: facts.json, census.json, graph.json
faultline propose              # where to look
# write boxes, routes, stages and loops into .faultline/model/*.json
faultline check                # the gates; a draft prints what is not drawn yet
faultline place && faultline build
```

`examples/toy/.faultline` is a finished map of the toy made this way; run `brief`, `breaks`, `where`, `path` and `impact` inside `examples/toy` to read it. The format is in `skills/faultline/references/model.md` and `docs/CONTRACTS.md`.

## Evidence

Anything that watches the code can write a walk, a small JSON-lines file listing where a run went. `faultline walk add run.walk.jsonl` stores one, and `where` then reports a box as seen when a run reached it. Importers for coverage reports, logs and model checkers write walks too. Walks are scrubbed of paths, emails and secret shapes before they are stored. Details: `skills/faultline/references/evidence.md`. A walk lights the boxes of the functions it cites on a tool map too (`where` says "level: seen"), and `faultline build` puts it on the page. The other importers (`coverage import`, `evidence import-logs`, `import-statechart`) were not tried on a tool map.

## Files

```
.faultline/
  map/       model.json claims.json calls.json review-index.json story-index.json sources.json (+ review-checked.json after a review)
  read/      reading.json charts.json words.json journeys.txt
  story/     check.json                          from story check
  model/     00-system.json 10-flows.json        the page project, written by map
  page/      side.json ask.json                  what the page and the text commands share, written by map
  dist/      atlas.html  atlas.agent.json  BRIEF.md
  facts.json census.json graph.json signals.json  what the scanner read
```

`docs/CONTRACTS.md` says what every command reads and writes. `docs/SCALE.md` covers large code. `docs/DESIGN_BARS.md` is how the page must look and read.


## Licence

MIT. Faultline by EKG, Emergent Knowledge Group. Third-party software and its licences are in `THIRD_PARTY.md`.
