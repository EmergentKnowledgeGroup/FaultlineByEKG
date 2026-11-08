# Writing a large story by hand, across several agents

Use this only when you were asked to write a large story as a map in the model format (`references/story.md`, job B). It does not apply to getting a map: `faultline map` reads code of any size by itself. A story's own project folder is separate from the tool map's.

One agent cannot keep a 100,000-line codebase in its head. Split the story by stage and let the tools keep track of the whole. Even alone, work one stage at a time in this order.

## 1. Survey (one agent, no boxes yet)

```
faultline init --project <dir> --name <name>
faultline extract --project <dir>
```

Put the source folder and any include list in `<dir>/config.json`: `{"root":"../my-repo","include":["src/**"]}`. A relative `root` is read from the project folder, so the file holds no path from your machine. Keep the project folder outside the repo if the map is private. A root that points outside the folder holding the project is not used on its own (a cloned project folder could point anywhere), so then pass `--source <repo>` to `extract`, `signals` and `build --excerpts`.

Read the extract summary, `graph.json` clusters, the README and the architecture docs. Answer the seven questions in `references/story.md` (job B). Then write:

- **`model/00-system.json`**: system, stages in story order, terms. Stage ids start with `s_`.
- **`stageplan.json`**: every module to exactly one stage: `{"modules":{"parcelworks/jobqueue.py":"s_queue"}}`. Modules with no logic can be excluded in the model with a why instead.

One enormous module that spans many concerns can be split by function name: `"split":{"parcelworks/jobqueue.py":[{"match":"^Queue\\.(hold|release_hold)$","stage":"s_trouble"}]}`. First match wins; anything unmatched stays with the module's own stage.

Check it: `faultline plan` prints one line per stage and every module nobody owns. Aim for 300 to 1500 lines of real logic per box-worthy area, and no stage carrying more than about 120 census rows. A stage that large should be two stages. Clusters are a hint, not an answer: the stage list is the owner's view of the system, not the import graph's.

## 2. One agent per stage

Each stage's agent runs `faultline worklist <stage>` and owns exactly two files:

- `model/NN-<stage>.json`: that stage's boxes, routes between its own boxes, ledger lines, loops, module exclusions. Split it (`NN-<stage>-a.json`) past a few hundred lines.
- `handoffs/<stage>.json`: roads leaving this stage.

```json
[{ "from": "work.book", "toSymbol": "parcelworks/jobqueue.py::Queue.fail", "toLine": 121, "type": "forward",
   "when": "Carrier unreachable", "why": "book_carrier raised TransientError.",
   "refs": [{ "path": "parcelworks/worker.py", "symbol": "parcelworks/worker.py::Worker.process_one", "line": 25 }], "inferred": false }]
```

Name the far side **by the code it calls**, because you don't know the other stage's box ids yet. `from` must be your own box. If you can read another stage's model file and know the id, `"to": "<box id>"` works too.

Every agent reads the code it maps. `worklist` tells it what to look at, and the rows say where decisions and endings are. Reading only the function names is how the job shrinks. "Rows left 0" is the floor, not the job: the census only counts what the parser can see, so a stage can say "0 of 0" with its real decisions sitting in try/catch, boolean tests or scripts in another language. Read those functions anyway.

**How a hand-off lands.** `join` looks for a box whose `handle` or FIRST ref is that function. A `toLine` exactly on such a box picks it; otherwise it takes the function's entry and never one of its endings if another box cites the function. So put the function a box is about first in its `refs`, and name helpers it merely calls in `why` instead. A box citing a foreign function as a later ref can capture roads meant for someone else; `join` lists those in `handoffs.review.json`. If you can read the other stage's file and know the box, write `"to": "<box id>"`. A function no box cites will not resolve at all.

**A `return` lands on the box that calls into your flow,** not on the entry of the function it goes back to. Give `toLine` as the call-site line. A raised error goes back to whoever catches it, and the tool can't tell that from a call, so write `"to"` on those. `worklist` shows how your returns would land.

Before it stops, each stage's agent:

```
faultline check --stage <stage> --project <dir>      # every offender in your stage, whatever other stages are doing
faultline worklist <stage> --project <dir>           # rows left: 0, or each listed in your report with a reason; also checks your hand-offs: how your returns land, and G5 AFTER JOIN for any exit that needs a condition
faultline place --stage <stage> --project <dir>      # lays out your charts
faultline look --stage <stage> --project <dir>       # PNGs from the saved layouts. Open them
```

A stage of up to 21 boxes has one chart, `stage_queue` for `s_queue`. A bigger one is split into families of connected boxes, `stage_queue_1`, `_2` and so on. Give a part a readable name by setting `partName` on any box in it; otherwise it takes the title of its first box. Never run `join` yourself: it rewrites a file the integrator owns, and `worklist` already tells you where your hand-offs would land. All these work while another stage's file is refused, so you never need a private copy of the project.

Every failure and refusal ending of your stage gets a `heardBy` entry (`references/model.md`): follow the news until someone hears it. `check` warns W-heard on any you missed.

Say in a report what you could not follow, what you merged most, which rows you doubt, and what surprised you, with file and line.

## 3. Integrate (one agent)

```
faultline plan        # who is done
faultline join        # handoffs/*.json become model/80-handoffs.json; lists what could not resolve
faultline propose     # roads the call graph shows that nobody drew: --into-islands first, then --cross-stage, --stage <id>; each hint has its call site and the box holding it
faultline check
```

The integrator owns `00-system.json`, `70-*`, `90-*` and `dismissed.json`:

- Resolve unresolved hand-offs, then read `handoffs.review.json`: later-ref landings, ties, and roads onto another stage's ending. Each is a place the map may lie. Fix the `to` in the hand-off file, or drop the row if the road is not real, and run `join` again. Never edit `80-handoffs.json`, since `join` rewrites it; a re-pointed road gets a new id. Running `join` twice writes the same bytes, but a newer tool can land rows differently. So once a map has been audited, diff `80-handoffs.json` before and after a tool upgrade and pin what the audit checked with `to`, since a landing checked by hand can be better than a clean join on the rows that moved.
- Draw the roads `propose` shows that matter. Most call-graph hints are noise: read the code, take what is a real road, and write its condition.
- Write `paths` (the main path first, from where a request starts to where it ends, with boot on its own path) and `loops` that span stages. Put `paths` in `00-system.json`: files merge in name order, so the first path found is the spine, and a stage file's path would otherwise win. A path may repeat a box, because calls come back. The first box of each path, and any external with no road in, are the declared entries that `no-way-in` and `unreached-from-start` read, so a stage nothing calls needs an external box for whoever does. `faultline path` can take shortcuts, so build a main path from landmarks and read it.
- Read the map as a stranger. Are any boxes islands? Any ending nothing reaches? Any stage with one road in and none out? Fix those or say why they are right.
- Name every chart part for what it does, in `model/95-parts.json`: `{"partNames": {"<any box id in the part>": "Hold and release"}, "partNotes": {"<any box id in the part>": "One line on what it does, at most 110 characters"}}`, at most 48 characters a name, in the owner's words. A part otherwise takes its first box's title, and readers get lost when a chart called "Take a parcel" holds the release path. `faultline parts` shows what each part holds and any name problem; `check` warns W-part-name. Names follow boxes, so run it again after boxes move.
- `faultline analyze`, with `--stage <id>` to take it a stage at a time, and `--all` for one line per candidate (`--full` for every field): read the code at each candidate. Keep it (`--keep KEY --why`) or dismiss it (`--dismiss KEY --why`). Never bulk-dismiss. A dismissal has to answer the question the candidate asks. If the question is "what has each caller finished when it gets here?", "one function, same arguments" does not answer it, and can hide a real fault. When you can't answer it from the code, keep it: a kept suspect costs a reader a minute, and a wrong dismissal hides the fault from everyone after you.
- `faultline place`, `build`, `look --page`. Open every chart.

## Timing

What `place` costs is in `docs/SCALE.md`. The whole map of more than 120 boxes is composed from the stage charts, so place the stage charts first. `place --prune` removes layout files of charts that no longer exist. `build --draft` builds a page even when charts have no layout, and lists them as not drawn.

A command that runs far longer than `docs/SCALE.md` says is a problem to report, not something to wait out. Don't sit in a sleep or poll loop on a long job: waiting costs time and tokens, and the job does not run faster for being watched.

## If you are one agent on a big codebase

Do stages in story order and hand off at the end of each one. Your notes and the fragments are your memory: `faultline plan` and `worklist` tell you where you are after a restart. A draft with six real stages and an honest gap list is worth more than a thin pass over twenty.
