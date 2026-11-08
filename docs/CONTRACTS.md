# Faultline by EKG: contracts

The code, the page and the tests all build against this file. If you change a contract, change this file in the same commit.

**Product in one line:** one system, one map, two readers, and now two layers. Layer 1, the tool map, is made by programs from the code: no agent, no key, no model. Layer 2, the story, is words an agent or a person writes, which the tool checks against Layer 1. A person gets an interactive page. An agent gets a token-efficient text view of the same map. Evidence of where things break lights up both.

**Boundary:** programs build the map. An agent answers the tool's questions (`faultline review`) and may write a story (`faultline story`). It never draws, never places boxes by hand, and cannot add or remove a box or a road on the tool map. Every check says "joined by the tool" or "words, not checked", never "proven".

**Words:** "the code" is what was read. "The tool" is Faultline. A claim is one statement the tool makes about the code, with a reason. It is confident or not confident.

## 1. Layout on disk

```
<repo>/.faultline/            (or any --project dir; the "project dir")
  facts.json census.json graph.json      tool output (extract)
  signals.json                           tool output (extract, or faultline signals): pairs, sticky flags, lost wakeups, never-sent names, empty handlers, swallowed errors. Optional: without it those checks do not run
  model/*.json                           fragments written by hand (or by `map`, see below), merged in filename order
  model.merged.json                      tool output (check)
  proposals.json                         tool output (propose)
  layout/<chartId>.json                  grid config: tool draft, may be overridden
  walks/*.walk.jsonl                     evidence from any source
  dismissed.json                         {findingKey:{why,by,at}}
  dist/atlas.html                        the human view, one self-contained file
  dist/atlas.agent.json                  the agent view's compact data
  dist/BRIEF.md                          brief of the whole code, for agents
  dist/svg/<chartId>.svg
  dist/png/<chart>.png  dist/shots/*.png from `look` (needs a browser)
  receipts.json
  map/                                   tool output of `faultline map`: model.json claims.json calls.json review-index.json story-index.json (and _work/, the type checker's scratch folder)
  map/review-checked.json                `faultline review check`: the checked answers (replaced by each check)
  read/                                  tool output of `faultline map`: reading.json charts.json words.json journeys.txt
  page/side.json                         tool output of `faultline map`: which boxes and roads are not confident, for the page
  page/ask.json                          tool output of `faultline map`: the page's ranked questions, the numbers of what was read, not read and open, and the long-to-short box id table; the text commands read it
  story/check.json  story/model.json     `faultline story check` and `story apply`
  dist/atlas.plain.html                  the page as built, before the Reader was added (`map` makes it, and starts from it when run again)
  dist/atlas.story.html                  `faultline story page`: the page plus the story's marks
```

A project made by `faultline map` has `model/00-system.json` and `10-flows.json` written by the tool, not by an agent, and its system is marked `"toolMap": true`. `faultline map` refuses a project folder whose `model/` holds anything else, so that a map written by hand and a map made by the tool never overwrite each other. A project folder may also hold `config.json` with `include` and `exclude` globs (and `sourceBase`); `map` creates it with empty lists when it is missing, reads the files the scan counts as source, and so narrows the map and the scan together.

## 2. facts.json (tool output, `schema: "faultline.facts/1"`)

```jsonc
{ "schema":"faultline.facts/1", "root":"..", "pin":{"git":"<sha or null>","tree":"<sha256 of file hashes>"},
  "languages":{"py":120,"ts":40},
  "modules":[{"path":"pkg/queue.py","lang":"py","lines":412,"sha256":"..","imports":["pkg/db.py"],"externalImports":["sqlite3"],"doc":"first docstring line"}],
  "functions":{ "pkg/queue.py::Queue.claim":{
      "path":"pkg/queue.py","qual":"Queue.claim","line":40,"end":88,"sha256":"..","doc":"","async":false,"decorators":[],
      "calls":["pkg/db.py::connect"],"unresolved":["self.foo"],
      "branches":[{"line":44,"kind":"if|elif|match|ternary|try","test":"short source text, max 80 chars"}],
      "returns":[{"line":50,"expr":"short source text, max 80 chars"}],
      "raises":[{"line":55,"type":"QueueEmpty"}],
      "excepts":[{"line":60,"type":"OSError","swallows":true}],
      "loops":[{"line":70,"kind":"while|for|recursion","bounded":false,"why":"while True with no break-by-count"}],
      "retryHints":[{"line":72,"why":"sleep/backoff/attempt counter inside a loop"}]
  }},
  "entries":[{"fn":"pkg/cli.py::main","kind":"main|cli|route|handler|worker|export|test","why":"if __name__ guard"}],
  "switches":[{"name":"RETRY_LIMIT","path":"pkg/config.py","line":12,"default":"5","kind":"env|config|flag|const"}],
  "enums":[{"name":"JobStatus","path":"pkg/types.py","line":3,"values":["pending","done","failed"]}] }
```
`root` says where the source folder is as `..` steps up from the project folder (`"."` when they are the same folder, `null` when the project sits outside the source folder, so the file names no folder of the machine that wrote it). Older files may hold an absolute path; readers accept both. `signals.json` does the same.

Function ids are `<repo-relative path with forward slashes>::<qualname>`. Excluded by default: tests, vendored and generated code, virtualenvs, node_modules, dist, build, runtime. Test files are scanned only for `entries` with kind `test`. `--include/--exclude` override.

## 3. census.json (tool output, `schema: "faultline.census/1"`)

A floor taken from code, never from logs or traces. Rows have stable ids that survive reformatting: `<kind>:<fnId>:<n>` where n counts that kind within the function.

```jsonc
{ "schema":"faultline.census/1",
  "outcomeTypes":[{"name":"JobStatus","source":"enum|declared|inferred","path":"..","line":3,"values":["done","failed"]}],
  "endings":[{"id":"end:pkg/q.py::Worker.run:0","fn":"pkg/q.py::Worker.run","line":90,"kind":"outcome|raise|exit|status","value":"failed","confidence":"high|medium|low"}],
  "branches":[{"id":"branch:..:0","fn":"..","line":44,"test":"..","weight":"decision|guard|trivial"}],
  "passes":[{"id":"pass:..:0","fn":"..","line":70,"kind":"retry|loop|recursion|scc","bounded":false,"members":[]}],
  "switches":[{"id":"switch:RETRY_LIMIT","path":"..","line":12,"default":"5","offByDefault":false}],
  "counts":{"endings":0,"branches":0,"passes":0,"switches":0,"rawReturnsAndRaises":0} }
```
Raw "every return and raise" is useless at scale (on large code, a very long list of rows versus a short one once counted through declared outcome types). So the census counts through declared and inferred outcome types plus raises and exits that escape a top-level entry, and marks trivial guards `trivial`. Only `decision` branches and non-low endings are required by the ledger.

## 4. graph.json (tool output, `schema: "faultline.graph/1"`)

```jsonc
{ "schema":"faultline.graph/1",
  "callEdges":[["fnA","fnB"]], "importEdges":[["modA","modB"]],
  "scc":[{"id":"scc0","fns":["..."]}],                 // Tarjan: real recursion or mutual-call cycles
  "clusters":[{"id":"c0","modules":["..."],"fns":["..."],"cohesion":0.7,"label":"guess from path and names"}],   // Louvain on the combined graph
  "depth":{"fnId":3},                                  // BFS depth from entries
  "hubs":[{"fn":"..","in":40,"out":3}] }
```

## 5. The model (written by hand, or a story; `schema: "faultline.model/1"`)

The one source of truth for a map written by hand, and the format of a story (section 16). The tool map has the same shape (section 14), written by the tool. Fragments in `model/*.json` merge by concatenating arrays and merging objects; duplicate ids refuse.

```jsonc
{ "schema":"faultline.model/1",
  "system":{"name":"","tagline":"","summary":"","purpose":"what counts as success","source":{"root":"","pin":""}},
  "stages":[{"id":"s_queue","title":"","blurb":"","order":1,"color":null}],
  "boxes":[{
    "id":"queue.claim",            // stable, kebab or dotted; never reused for a different thing
    "stage":"s_queue",
    "kind":"step|decision|wait|end|store|external|gate",
    "title":"",                    // target <=34 chars, hard max 40; verb phrase for actions, noun for states
    "handle":"",                   // optional official name the code itself uses (shown as a chip); never invented
    "partName":"",                 // optional: when this box's stage is split into charts, the name of the chart that holds it (<= 48 chars). The first box in the part, in reading order, that has one names it. A top-level "partNames": {"<any box id in the part>": "Name"} does the same from one file, usually model/95-parts.json, and wins
    "plain":"",                    // <=260 chars; plain words, keeps the code's own terms
    "why":"",                      // optional: why this exists
    "status":"live|default-on|off|test-only",
    "switch":"",                   // census switch id when status is off or default-on
    "refs":[{"path":"","symbol":"pkg/q.py::Worker.run","line":90}],   // at least one; symbol must exist in facts
    "inputs":[],"outputs":[],"failure":"",
    "outcome":""                   // for kind=end: success|failure|refusal|neutral
  }],
  "routes":[{
    "id":"r_claim_empty","from":"","to":"",
    "type":"forward|return|record|deliver",   // return = loop back or retry, drawn red dashed; record = writes evidence or a side effect; deliver = hands something to a person or outside
    "when":"",                     // the CONDITION, <=28 chars. Never a description. "Queue empty", not "checks the queue"
    "why":"",                      // the exact condition or reason in a sentence
    "refs":[{"path":"","symbol":"","line":0}],
    "inferred":false               // true = no code path proves it (events, queues, config); shown as lower trust
  }],
  "loops":[{"id":"","title":"","blurb":"","boxes":[],"limit":"what bounds it, or empty if nothing does"}],
  "paths":[{"id":"main","title":"Main path","boxes":[],"blurb":""}],     // the first path is the happy path
  "charts":[{"id":"","title":"","summary":"","boxes":[],"role":"detail"}],  // optional extra views; the tool always makes: overview, one per stage (split above 21 boxes), whole
  "terms":[{"term":"","meaning":"","refs":[]}],                          // the code's own vocabulary
  "ledger":{ "<censusRowId>":{"box":"id"} , "<id2>":{"route":"id"}, "<id3>":{"merged":"box id","why":""}, "<id4>":{"excluded":"why"} },
  "modules":{ "<module path>":{"excluded":"why"} },                      // every other module must be cited by some box
  "partNames":{ "<any box id in the part>":"Name" },                     // optional: names a chart part of a split stage (see partName above)
  "partNotes":{ "<any box id in the part>":"one line" },                 // optional: what that part is for, <= 160 chars; replaces the stage blurb on the part
  "heardBy":{ "<box id>":{"by":"person|outside|event|caller|log|nobody|unclear","how":"short phrase"} },  // optional: who hears about this ending
  "waitsFor":{ "<wait box id>":{"on":"person|machine|outside|time","how":"short phrase"} }                  // optional: what a wait box waits for
}
```

**Optional top-level maps** (each is merged from any fragment, a later key never wipes an earlier one; a model without them keeps working, and nothing below is a gate):

- `partNames` and `partNotes` (chart parts). The first box of the part, in reading order, that has an entry gives the part its name and its one-line purpose. `partNotes` takes the place of the stage blurb that every part of a split stage would otherwise repeat; the page shows the stage it belongs to in small type. Neither changes a chart's geometry key, so naming or noting a part never causes a re-place.
- `heardBy` (who hears about an ending). Only the code can say it, so the page never guesses: a box with no entry reads "not said yet". It usually sits on an end box, but any box may carry it (a failure can be heard about while the story goes on: an `error` event emitted at a step, then the flow continues). Values: `person` a person using the system is told; `outside` sent to a party outside the system; `event` published for whoever listens (an event, a metric, a webhook); `caller` thrown or returned to the code that called; `log` only written to a log; `nobody` no trace; `unclear` the code does not settle it. `how` is a short phrase in the code's own words. The page groups and filters the hand-off list by it, shows "Who hears" on the box panel, and opens a section **Failures nobody is told about** in Where it can break for every box heard by `nobody` or `log` unless its outcome is success, refusal or neutral (rows carry state `silent` and check `silent-failure`). `faultline where <box>` prints it and `faultline breaks` lists the silent failures within its token budget (`--silent` lists them all).
- `waitsFor` (what a wait waits for). Only the model's author can say it, so the page never guesses it from the words of a box: a wait with no entry is treated as it always was. Values: `person` (a reply, a click, a form filled in), `machine` (another part of the system: a lock, a queue, a promise), `outside` (a system beyond this one), `time` (a timer or sleep). `how` is one short phrase, shown verbatim ("sleeps one second, then asks the queue again"). A wait on a **person** goes into its own closed group "Waiting for a person" in Where it can break and is **not counted** in the "to look at" total (the page says so); the other waits keep their place and show what they wait for. `faultline check` warns **W-waits** (never refuses) on an entry that names a box that does not exist, one that names a box that is not a wait, and one with an unknown `on`.
- Failures and refusals nobody is told about (page "Where it can break"): a box heard by `nobody` (a failure or a refusal: the person clicked and nothing showed) or by `log` (a failure only: a logged refusal is the system saying no in its own way). A success or a neutral ending never is.
- `faultline check` warns **W-heard** (never refuses) on an entry with an unknown `by`, on an entry that names a box that does not exist, and on a failure or refusal END box with no entry. A box that is not an end box may carry an entry.

- What the page reads from these: a wait node carries `waits {on, how}`; `holds` lists what can hold up the main path (src/build/holds.mjs: a row per wait box, gate box and loop that touches the declared path, in path order, `state` kept | open | held | dismissed | none, with `why`, `limit`, `on`, `how`); a break row may have `state: 'person'` (a wait for a person, outside the count of things to look at). `meta.counts` gained `fails` (failures and refusals by who hears; the unit is a box), `mainPath` {steps, boxes, stages}, `stageRoads` {stage: {boxes, inside, enter, leave}}, `switches`, `waits` and `holds`, each defined once in src/build/counts.mjs. A chart's loop may carry `total` (its boxes in all) when the chart draws only some of them. The parts of a stage are numbered so part 1 is the part the stage opens on.

**Display rules enforced by the tool:** titles, `when` and `plain` length limits; same concept same wording; `when` may not start with a description verb (checks, handles, manages, processes, uses, supports, can, may, might).

## 6. Gates (`faultline check`)

Each refusal is `REFUSE <code> <what>: <first offender>. Fix: <how>.`; each returns `{code, msg, at}`.

Always hard (draft and finished): G1 cited symbol missing from facts or line outside it. G2 box without refs. G3 dangling route. G4 duplicate id. G5 route with empty `when` out of a box with 2+ exits. K1 box without kind or status. L1 layout hard metrics non-zero (nodeOverlaps, edgeThroughNode, trackOverlaps, labelOverlapsLabel, labelOverlapsNode, diagonalSegs, shortArrowStubs, labelMissing). T1 text over limits.

Hard only for finished (`--finished`), printed as a gap in a draft: B1 census ending or decision branch unaccounted in the ledger. B2 merges above 8 per box without `why` per row, or exclusions above 25% of a census kind. M1 module neither cited nor excluded. S1 60%+ of boxes have exactly one in and one out while census has 10+ decision branches (a straight list). S2 no return route though census has passes. E1 fewer end boxes than distinct non-low census outcome values. A1 finding unresolved (neither `suspect` nor dismissed with a why).

A map marked `toolMap` (written by `faultline map`) has no ledger, so B1, M1, E1, S1 and S2 are not applied to it; every other gate is.

`build` re-runs every gate itself; it never trusts `receipts.json`. The page and BRIEF print: draft or finished, census tally, what is not drawn yet.

## 7. Findings (`faultline analyze`, stored in the check output)

```jsonc
{"key":"can-only-go-back:queue.hold","check":"can-only-go-back|pile-up|hedged-route|no-limit-loop|ending-no-test|declared-never-produced|no-way-out|unreached-from-start|lost-wakeup|sticky-flag|restart-misses|never-sent|wait-no-wake|empty-handler|swallowed-error|shared-decision",
 "boxes":[],"routes":[],"level":"suspected","question":"5 roads in, only exit goes back upstream: what triggers the later request?","evidence":"one line"}
```
Order: kept suspects first, then how many different checks agree, then the fixed check order (lost-wakeup, sticky-flag, restart-misses, never-sent, shared-decision, wait-no-wake, empty-handler, swallowed-error, then the older flow checks, no-limit-loop last). The signal checks (lost-wakeup, sticky-flag, restart-misses, never-sent, empty-handler, swallowed-error) read signals.json; a signal no box cites is still a candidate, with its file:line in the evidence and `boxes: []`. Their keys are built from the code (function id and field, enum name, file and line), not from box ids, so a dismissal survives a redrawn map. Say "candidate" plus the shape, never "bug" or "dead end". "Not drawn", never "does not exist". "No limit shown", never "unbounded". Group by cluster, cap 10 shown (kept suspects take at most 5 of them, open candidates the rest by rank), no fake precision in ranking. A finding may carry `lead: true` (swallowed-error): a weak shape, never shown by default, not counted by gate A1, listed by `analyze --all` and `breaks --leads`; keeping it as a suspect makes it a candidate. A `dismissed.json` entry whose key no longer fires stays in the file and is counted by `analyze` as an orphan, not an error. `analyze --dismiss/--keep` record `by` (from `--by`, else "agent") and `at`. `dismissed.json` keys survive re-runs.

## 8. Walks (`*.walk.jsonl`): any evidence source writes only this

```jsonc
{"walk":1,"tool":"coverage.py@7","kind":"run|test|modelcheck|explorer|manual","pin":"<source hash or git sha walked>"}
{"label":"NONE|SAMPLED|BOUNDED_INCOMPLETE|EXHAUSTIVE_WITHIN_MODEL","controls_passed":false,"explored":["box ids or symbols"],"unexplored":[{"at":"box or symbol","why":"budget cut"}]}
{"outcome":"end:<box>|stuck:<box>|error|unknown","strength":"observed|replayable|proved-in-model|claimed","reason":"the source's own code or words","witness":"replay file or null","count":1,"steps":[{"ref":"file:line","sym":"fnId","tag":"box alias or stage name","action":"optional"}]}
```
Step to box, first match wins: `ref` inside a box's cited function body; `sym` equals a box's symbol; `tag` equals a box id or alias. No match is NOT MAPPED, never guessed. Two consecutive mapped steps with no route between them is "map is missing this route". Changed function hash marks that box STALE, not the whole map. Coverage lights a box only when a cited function's BODY ran, since a `def` line runs at import.

**Levels per box:** drawn (default), suspected (a finding), seen (observed walk or body coverage), proved (a replayable or proved-in-model walk). Only EXHAUSTIVE_WITHIN_MODEL with controls_passed may say "no violation found"; everything else says "not found in what was checked".

## 9. Optional explorer contract (JSON lines over stdin/stdout, any language)

`manifest` code and input hash. `initial` start states. `actions(state)` legal actions with stable ids. `apply(state,action)` pure, or rejected. `classify(state)` ok, end, wait, stuck, invalid or cut, plus a reason code. `identity(state)` exact bytes of the whole state. `where(state)` box id or symbol. `controls` known-answer states.

Runner rules: identity is a hash of full bytes, compared on collision; labels never merge or skip states; budgets for states, evaluations and seconds; resume refuses if the manifest changed; coverage label computed from facts, never claimed by the adapter; controls run first and refuse a checker calling everything or nothing stuck; a finding counts only when its action list replays; offline, no network, no child processes, writes only in its run folder. Output is a walk file. Out of v1: parallel workers, eventual-termination claims, witness shrinking, multi-actor.

## 10. The agent view

Same map, compact text. Every answer names box ids and ends with a deep link the person can open (`atlas.html#chart=<id>&node=<box>`). Hard caps on tokens: every command prints at most its budget and says how to get more.

| Command | Answers | Budget |
|---|---|---|
| `faultline brief` | What the code is, stages in order, main path, loops, endings, top candidates, what's not drawn, draft or finished | 1200 tokens |
| `faultline where <box id\|function id\|bare name\|file[:line]\|words from a title>` | Which box, its stage, plain sentence, every road in and out with conditions, level, candidates here; for an ending, whether it stops here or hands back to its caller; who hears about it (heardBy) or "not said yet" | 400 |
| `faultline breaks [--stage s]` | Candidates and proved breaks with their shapes, evidence and one question each; a line says how many failures nobody is told about and the first few follow (`--silent` lists them all) | 800 |
| `faultline path <a> <b>` | Along the declared path when both boxes lie on one (it says which); else a route the roads allow: a weighted search over forward roads, each road 1, each change of stage about 6, a main-path road far less, ties broken the same way every time. Not a promise that one request takes it. `--shortest` is the plain fewest-hops search | 300 |
| `faultline impact <box\|file>` | What's downstream, which endings are reachable, what depends on this | 500 |
| `faultline status` | Draft or finished, gaps, stale boxes, unexplored (a tool map: what was read, what is open, whether the page matches the map, the next step) | 200 |
| `faultline mcp` | The same six over MCP stdio. Tool descriptions under 40 words each | |

On a tool map the ids in these answers are the page's short ids (`f58.0` for a box, `c58` for a chart, `d1` for a stage, `l_f58.0` for a loop), numbered by the reading, so they can change when the code changes; `file:line`, a function id (`path::qualified.name`), a bare function name and words from a title also work. The review and story files use the map's own long ids (`map/model.json`); every command takes those too, and `review queue`, `review view` and `story check` print the short id beside each long one (`page` / `fromPage` / `toPage` in their files). A long id the page draws no box for is answered as its function. A function the page lists only as an outline is answered as a function, and one the reading drew no box for cannot be found by name.

On a tool map the text commands use the reading's words: `status` and `brief` say what was read, what was not and what is open (never DRAFT, a ledger or census rows, a run order or "Accounted"), and `breaks` and `brief` list the page's own ranked questions (the reading's `triage.questions`, kept in `page/ask.json`) with the same count, as many as fit the cap. `status` says whether the page matches the map by content: the build records a digest of its inputs (the model fragments and layouts, and for a tool map the reading) in `dist/atlas.agent.json` as `layout.page.inputs`, and file times are not looked at on either kind of map.

Token budgets are measured as chars/4. A human's page has a "copy pointer" on each box producing `faultline where <box>`, so a person can hand an agent an exact spot, and an agent can hand a person an exact link.

## 11. Function signatures between modules

```js
// src/engine
gridLayout(graph, cfg) -> Promise<geom>      // graph {id,title,nodes:[{id,title,category,...}],edges:[{id,from,to,type,label,...}],text?}
metrics(geom) -> {size,aspect,crossings,...hard metrics,fitScale,score,issues}
autoChannels(graph, cfg, {iters,penalty}) -> Promise<{cfg,...}>
renderSVG(geom, opts) -> string
// src/place
placeChart(chartGraph, {spine, seed=1, budgetMs=20000}) -> Promise<cfg>      // cfg is a gridLayout config; deterministic for a given seed
placeWhole(model, charts, {seed=1, budgetMs}) -> Promise<cfg>                // composes stage blocks into one config
// src/extract
extract(rootDir, {include,exclude}) -> Promise<{facts,census,graph}>
// src/model
loadModel(projectDir) -> model
validateModel(model, facts, census, {finished, geoms}) -> {refusals:[{code,msg,at}], warnings:[{code,msg,at}], gaps:{...}}
analyze(model, facts, census, overlay) -> findings[]
propose(model, facts, graph) -> {routes:[{from,to,evidence}], stages:[...], unmappedModules:[...]}
// src/evidence
importWalks(projectDir, model, facts, {keepMessages=false}) -> overlay  // {boxes:{id:{level,count,reasons,stale}}, routes:{id:{count}}, notMapped:[], missingRoutes:[], stale:[], unexplored:[], labels:[]}
//   the overlay goes into pages made for sharing, so it holds no absolute path, home folder, email or secret of the shapes listed in the header of src/evidence/scrub.mjs: paths are repo-relative or a base name, a home folder is <home>, and an outcome's `reason` (log text) is left out unless keepMessages
cleanWalk(walk, scrub, {witness}) -> walk   // what `walk add` stores: the same cleaning, the words of a reason kept
// src/build
chartsFromModel(model) -> [{id,title,summary,kind:"overview|stage|whole|detail",boxes,routes}]
toAtlasData(model, {geoms, findings, overlay, gaps, finished}) -> atlasData   // the blob viewer/ embeds; adds breaks[], portal main/syn, region path (see the header of src/build/atlasdata.mjs)
assemble(atlasData, outDir, {excerpts=false, keepComments=false}) -> paths   // the viewer's comments are left out of the page unless keepComments
// src/agent
agentData(model, {findings, overlay, gaps}) -> compact JSON  // dist/atlas.agent.json
// src/map (see src/map/CONTRACT.md and RULES.md)
readSystem(config) -> Promise<sys>            // the readers and the checkers; read only
mapSystem(sys, {name, clone=true}) -> {model, claims, ...}   // the rules; modelText(model) and claimsText(claims) are the bytes written
buildItems(map, claims, root) -> items        // review questions; checkAnswer(item, answer, src, claimsById) -> result
// src/read
readSystem({model, claims, facts, signals, calls, spans, sourceRoot, name, notes, chartBytes}) -> {reading, charts, words, text}   // src/read/index.mjs
mapToPage(opt, say) -> {line, times, notes, files, page, pageBytes, hardLeft, numbers, charts}   // src/read/page/run.mjs: what `faultline map` runs
// src/story
loadStory(target) -> {story, refusals}        // checkStory(story, {mapDir, root, allowStale}) -> check; applyWords(mapDir, overlay) -> {model, report}; buildPage(checkFile, pageFile) -> {html, dataBytes, nRoads, nBoxes}
```

Node 24+ (tested on 24.13.0, Windows 10; see the README). ESM. Paths are read in Windows and POSIX forms, but only Windows has been tested. Python only for the Python extractor (stdlib `ast`; tested on 3.13). No network at run time.

## 12. Hard rules for all code here

- Code, comments, tests, docs and fixtures name no real codebase, person or project. Examples use the toy in `examples/toy` or generic words.
- No hard-coded absolute paths or Windows-only assumptions. Chromium is discovered (`CHROME_PATH`, playwright's cache, then system browsers); if absent, PNG and look steps say so and everything else still works.
- Deterministic: same input gives identical output. Seeded randomness only.
- Match surrounding code style. Keep comments as dense as the file they sit in.

## 13. Scale tools: hand-offs, join, propose, part names

Added for large maps; every addition is optional data, nothing above was removed.

- **Return hand-offs land on the caller.** A `handoffs/*.json` row of type `return` without `to` lands in two phases: every other row first, then each return on the box that calls into the returning box's flow (a forward road into it, or into a box it is reachable from), in the order: a box citing exactly `toLine`; the fewest forward hops; the cited line nearest `toLine`; model order. No caller found: nearest line to `toLine`, else the first box. `handoffs.review.json` gets one row per return landed this way: `reason` is `return-caller`, `return-line`, `return-nearest-line`, `return-first` or `return-tie`, with `how`, `hops` and `candidates`. The last three, and `return-first`, are questions (`ASKS` in `src/build/handoffs.mjs`); the others only say how it landed. A row with an explicit `to` is never second-guessed.
- **`join` is idempotent.** The routes already in `model/80-handoffs.json` are not an input to landing, so two runs write byte-identical `80-handoffs.json`, `handoffs.review.json` and `handoffs.unresolved.json`.
- **`worklist` checks a stage's own hand-offs** for G5 as it will be after join (`G5 AFTER JOIN`: a box with several exits once the hand-offs are added, one of them with an empty `when`), and says how its returns would land.
- **`propose`** hints are `{from, to, type, evidence:{chain,hops}, site:{at,lineKnown,fn,calls}, holder:{box,also}, alsoFrom?, conditionHints, fromStage, toStage, crossStage, intoNoWayIn, fromNoWayOut, fromIsland, reverse}`, sorted: into a box with no road in first, then the call-graph distance. `site.at` is the call line in the calling function (from `callAt` in facts.json); `holder` is the box whose cited line is the last at or above it, and a hint from a box that does not hold the call is left out (`counts.sameCallElsewhere`). `propose(model, facts, graph, census, {maxRoutes, perBox})` defaults to 200 and 12 per box; the command asks for all and prints the top 40 (`--stage`, `--cross-stage`, `--into-islands`, `--limit`, `--offset`). The result also carries `noWayInNoHint`: boxes nothing leads to that no hint reaches, with their direct callers.
- **`signals.json`** gains `produced: {"<declared string value>": {n, at:["path:line", ...3]}}`, the values the code writes as plain literals (assigned, in a dict, returned). `declared-never-produced` reads it, plus the quoted strings and member names in every function's `returns[].expr`; its evidence says when assignments were not searched (no `produced` list).
- **Part names.** A stage chart that is split carries `name`, `entry`, `first` (its first boxes in reading order), `nameBox` (the box that gave the name, null for the first box's title), and, when needed, `nameDup` (the name two parts of one stage share; the page numbers the second) and `nameOther` (a second name given to the same part). `validateModel(..., {charts})` adds `W-part-name` warnings from them (`src/model/partnames.mjs`): a name used by two parts of a stage, a name given to boxes in several parts, one part named twice, a `partNames` key that is not a box.
- **`place`** lists `layout/` files no chart has the name of (an earlier partition) as STALE and removes them only with `--prune`.

## 14. The tool map: `faultline map`

`faultline map --source DIR [--project DIR] [--name TEXT] [--no-page] [--python GLOB ...] [--python-exclude GLOB ...] [--typescript PREFIX] [--ts-exclude PREFIX ...] [--tsconfig FILE] [--lua PREFIX] [--config FILE] [--tools DIR] [--interpreter EXE] [--work DIR] [--quiet]` goes from code to a finished page in one run. `src/read/page/run.mjs` (`mapToPage`) is the whole of it.

**Reads.** The source folder, read only (never written, no git command: the commit is read from `.git/HEAD`). Dependency, build, cache and version-control folders are skipped (`SKIP_DIRS` in `src/map/files.mjs`). `<project>/config.json` (`include`, `exclude`, `noDefaults`, `sourceBase`; created empty when missing). A Python 3.10 or newer interpreter (`--interpreter`, else `$FAULTLINE_PYTHON`, else `python`, then `python3`) and the checker `ty` for Python. The TypeScript compiler for TypeScript and JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`), using a `tsconfig.json` when the code has one or `--tsconfig` names one. The Lua grammar for `.lua`. With no language flag it reads exactly the files the scan counts as source, so every box cites a file the scan lists; a language flag reads a part (`--python GLOB` while the scan still counts every file).

**Stages and what each writes.**

| Stage | What it does | Writes |
|---|---|---|
| 1 read | the language readers and the checkers' answers | `map/_work/` (the checker's scratch) |
| 2 map | the rules draw boxes and roads and make every claim | `map/model.json` `claims.json` `calls.json` `review-index.json` `story-index.json` |
| 3 scan | facts, census, graph, signals (section 2 to 4) | `facts.json` `census.json` `graph.json` `signals.json` |
| 4 reading | the code's name and purpose, journeys, main path, endings, who hears, switches, terms, one chart per function worth a picture, and the one record of numbers | `read/reading.json` `charts.json` `words.json` `journeys.txt` |
| 5 project | the reading as a Faultline project, marked `toolMap` | `model/00-system.json` `model/10-flows.json` `page/side.json` `page/ask.json` |
| 6 place | the charts, in parallel shards (at most 4 child processes; 4 GB heap each, 8 GB for the overview and the repair pass) | `layout/*.json` |
| 7 build | the page, then the Reader and the tool-map data are injected | `dist/atlas.html` `atlas.plain.html` `atlas.agent.json` `BRIEF.md` `svg/` |

`--no-page` stops after stage 5. A second run into the same project reuses what is placed. A page stays under `PAGE_LIMIT` (15,500,000 bytes, `src/read/page/run.mjs`); the charts drawn are chosen by an estimate of their bytes (`HOT_BYTES` in `src/read/charts.mjs`), and a page over the limit is made again with the budget lowered by the excess, up to three more times. A function that gets no chart is read as an outline in the Reader.

**Notes, not refusals.** What could not be read is said on a `note:` line and on the page under "What was not read", and the rest is mapped: `no-python` (no Python 3.10 or newer; Python files skipped), `no-checker` (`ty` not installed; no negative claims about Python and its effects stay `maybe:`), `checker-incomplete`, `no-typescript`, `no-lua-grammar`, `no-signals`. A named interpreter that does not run is a refusal, not a note. Nothing to read at all is a refusal.

**The same bytes.** The same code, the same tool, the same checker versions and the same Python environment give identical files. The header of `map/model.json` (`system.environment`, `system.resolvers`) states the interpreter's major.minor version and a digest of its installed packages, `ty`'s version and the compiler's version and configuration. Nothing in a written file comes from the clock or a random source.

### Claims (`map/claims.json`)

```jsonc
{ "id":"d:parcelworks/intake.py::accept:39:queue.enqueue:maybe:emit", "type":"declined",
  "subject":"parcelworks/intake.py::accept:39", "fn":"parcelworks/intake.py::accept", "path":"parcelworks/intake.py", "line":39,
  "says":"queue.enqueue might be emit (not asserted)", "conf":"not-confident", "reason":"effect-candidate",
  "why":"the checker made no claim for this call", "pinned":false, "template":"effect", "main":true, "failure":false }
```

Types: `kind effect declined wait hears exc-road title negative entry call-road cfg-road link-road`. `conf` is `confident` when a type checker, the control-flow graph or a definition table decided it and no open end sits behind it, and `not-confident` when the tool wrote its label on thinner evidence than the words (a name match, several possible targets, an open end) or declined to write the label at all (`maybe:`). `pinned` is true when the checker or the flow graph decided it; nothing an agent writes can touch a pinned claim. `reason` is a code with a plain sentence in `why` (`src/map/reasons.mjs`). Nothing here changes a box, a road or a byte of the model.

### The tool map (`map/model.json`)

`schema: "faultline.model/1"`, `tool`, `system`, `stages` (one, `s_all`), `boxes`, `routes`, `loops`, `paths`, `terms`, `charts`. Every box and road carries `prov` (the rule that drew it, the function and line, and for a road its `tier`: `proven`, `may` or `linked`). Box ids are `<file stem>.<qualified name>.<code>`, which is a different set from the page's short ids (`f58.0`). A box's `title` is a slice of the source or a plain phrase the tool wrote; `plain` is empty unless a story adds words (`box.words`).

### What the page reads

The page and the text view treat a project as a tool map when its system carries `toolMap`. Then the viewer shows tool-map wording (see `DESIGN_BARS.md`), the page data carries `meta.toolMap` (success text, whether stages have an order, the numbers record, endings by outcome, the main path, switches, stage names), the boxes and roads the tool is not confident in carry `nc` (the reasons), and gates B1, M1, E1, S1 and S2 are not applied (there is no ledger). Every other gate is.

## 15. Review: `faultline review`

All three take `--map DIR` (default `<project>/map`), `--source DIR` (the folder given to `map`) and `--project DIR`. They refuse when the files under the source no longer match `review-index.json` (`source_digest`).

- `review queue [--limit N] [--out FILE]` groups the not-confident claims into questions and orders them: `main-failure` (on the main path, about a failure), `main`, `failure`, `rest`. File `faultline.review-queue/1`: `{schema, system, items:[{item, tier, rank, question, answers:[...], lines:[{path,line,text}], claims:[claim ids], template, path, line, fn, main, failure, depth}]}`. Each question has one concrete question and a closed answer set; `cannot-tell` is always in it.
- `review check --answers FILE [--store FILE]` takes `{ "answers": [ {item, choice, cite, quote} ] }` and nothing else per answer. The tool re-reads the cited file: the line must exist, hold the quote (3 to 200 characters), and for a positive answer show what the rule for that question accepts (`src/map/review_check.mjs`). It writes `faultline.review-checked/1`, `{schema, system, results:[{item, choice, cite, claims, status, rule, why, line_text, line_sha}]}`, to `map/review-checked.json`, replacing the last one. `status` is `checked`, `cited-only`, `opinion` (a negative answer: it cannot be checked against one line and moves nothing), `no-answer` (`cannot-tell`) or `refused` (`schema`, `no-such-item`, `pinned`, `choice`, `cite`, `line-exists`, `quote`).
- `review view [--without-agent] [--out FILE]` prints the claim list; each claim an answer touched gains `agent` (choice, status, cite, rule, line text). `conf` and `reason` are never rewritten, and `--without-agent` prints the claims byte for byte.

An answer annotates. It cannot add or remove a box or a road, and it cannot touch a pinned claim.

## 16. Story: `faultline story`

All three take `--project DIR`; `check` and `apply` also `--map DIR` and `--source DIR`.

- `story check --story FILE|DIR [--out FILE] [--allow-stale]` loads a story (a model file, or a folder of `.json` fragments or its `model/` folder; arrays join, ids must be unique, else it is refused with `S-dup` and exit 3) and gives every box and road a verdict from the tool map alone. It reads each box's `id`, `kind`, `refs` and `outcome` and each road's `from`, `to`, `type`, `when` and `refs`; a cited path that leaves the source folder is refused and never opened. Writes `story/check.json` (`faultline.story-check/2`: `summary` with `header`, `join`, `found`, `flags`, `marked`, `paths`, `roadTypes`, `whenLabel`, `boxKinds`; `roads`, `boxes`, `vocabulary`, `limits`, `cannotSee`). A road is "joined by the tool at this line", "joined by a route", "related in the code" or "no link found"; a box is "in a tool box", "real code, no tool box", "partly found" or "not found". A road that stands on a road the tool is not sure of is "related in the code". Titles, sentences and conditions are carried through "words, not checked". Exit 4 when the map is missing or the code changed since it was made, unless `--allow-stale`.
- `story apply --words FILE [--out FILE] [--report FILE]` takes `{by, words:{<map box id>:{title,plain}}}`. Only `title` (at most 34 characters) and `plain` (at most 260) are words; an unknown box, an empty or control-character value, any other field, any other top-level key and every road are refused one by one. The words go on the box as `words:{by,title,plain}` in `story/model.json`; the tool's own `title` and `plain` are never overwritten, and a recompute gate refuses the whole overlay if anything but `words` on a box differs from `map/model.json`. The report (`faultline.story-apply/1`) lists refusals and lint (`W-vouches`, `W-decision-not-a-question`, `W-decision-titled-as-exit`, `W-exit-title-on-non-end`, `W-dupe-title`).
- `story page [--check FILE] [--page FILE] [--out FILE]` copies the page and adds the overlay (marks, counts, a switch, the tool's words on hover) as `dist/atlas.story.html`.

## 17. What each command reads and writes

Every command takes `--project DIR` (default `./.faultline`, or the nearest one above) and `--root DIR` for the source folder.

| Command | Reads | Writes |
|---|---|---|
| `setup [--dir D] [--status]` | the pin in `src/map/pins.json` and, once, the published wheel | `<D>/ty-<version>/`, `wheels/`, `cache/` (D defaults to the per-user cache: `%LOCALAPPDATA%/faultline/tools` on Windows, `$XDG_CACHE_HOME/faultline/tools` or `~/.cache/faultline/tools` elsewhere; `FAULTLINE_TOOLS` overrides) |
| `map` | section 14 | section 14 |
| `review queue`, `view` | `map/`, the source | stdout; `--out FILE` |
| `review check` | `map/`, the answers, the source | `map/review-checked.json` |
| `story check` | the story, `map/`, the source | `story/check.json` |
| `story apply` | the words, `map/model.json` | `story/model.json`, `--report FILE` |
| `story page` | `story/check.json`, `dist/atlas.html` | `dist/atlas.story.html` |
| `init` | | `model/00-system.json`, `config.json`, `.gitignore` |
| `extract`, `signals` | the source, `config.json` | `facts.json` `census.json` `graph.json` `signals.json` |
| `propose` | facts, census, graph, model | `proposals.json`, and the gate files below |
| `check`, `analyze` | `model/*.json`, facts, census, signals, layouts, walks, `dismissed.json` | `model.merged.json` `receipts.json` `proposals.json`; `analyze --dismiss/--keep` also `dismissed.json` |
| `place` | the model, `layout/` | `layout/<chart>.json` and its `.geom.json` |
| `build` | the model, facts, layouts, walks | `dist/atlas.html` `atlas.agent.json` `BRIEF.md` `svg/`, and the gate files |
| `look` | the saved layouts, or the built page with `--page` | `dist/png/<chart>.png`, or `dist/shots/` (needs a browser) |
| `plan`, `worklist`, `parts` | `stageplan.json`, the model | nothing |
| `join` | `handoffs/*.json`, the model | `model/80-handoffs.json` `handoffs.review.json` `handoffs.unresolved.json` |
| `walk add`, `coverage import`, `evidence ...` | a walk, report or log file | `walks/*.walk.jsonl` (a cleaned copy) |
| `walk list`, `brief`, `where`, `breaks`, `path`, `impact`, `status`, `mcp` | the project (model, facts, signals, layouts, walks) | nothing |

`faultline map` is the only command that writes `read/` and `page/` and the only one that rewrites `map/` (`review check` adds `map/review-checked.json`). A project written by hand has none of them.
