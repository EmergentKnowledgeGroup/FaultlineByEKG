# The reading file

`readSystem({ model, claims, facts, signals, calls, spans, sourceRoot, name })` from `src/read/index.mjs`; `faultline map` calls it and writes the result.

It writes four files into `<project>/read/`. The same inputs give the same bytes (keys sorted, no clock, no random, no hashes).

| file | what |
| --- | --- |
| `reading.json` | everything a page states in words and numbers (this file is the contract) |
| `charts.json` | the drawn charts, the text outlines, one row per function |
| `words.json` | plain words for every box of the map, by the map's own box id |
| `journeys.txt` | the journeys as plain text, for people |

Inputs: the tool map (`faultline.model/1`), its claim register (a list), the source tree (read only). Three optional files add evidence; each is picked up from beside the model (`facts.json`, `signals.json`, `calls.json`) when not named:

- `--facts` the scanner's facts (function extents, call lines, branches, entries, module comments). With them a journey can follow calls the map draws no road for (marked `evidence:"scan"` and listed as engine gaps) and the glossary finds more comments.
- `--signals` the scanner's signals (lost wake-ups, flags that stay set, events never sent, swallowed errors); they feed the ranked questions.
- `--calls` the tool's call table (rows `[function, node, op, {f, line, how, rs}]`); calls it could not resolve to project code become the "continues, call not followed" markers and the `unresolvedCalls` count.

Without them the reader still runs: journeys use only the roads the map draws (fewer hops and fewer triggers), the glossary has fewer meanings, and the purpose can still come from the README or package metadata.

Ids are short and hash-free: `f<n>` a function, `c<n>` a chart (`c<n>p<k>` its parts), `f<n>.<k>` a box of function `f<n>` (by line order; `.c<k>` card, `.s<k>` stub, `.o` open marker, `.m<k>` "more functions", `.k<k>` part link). `ref` / `box` fields hold the map's own box id (provenance).

## reading.json

```
schema        "faultline.reading/1"
inputs        { modelTool, modelSchema, claims, facts:bool, signals:bool, source:bool }
system        { name, languages:{ts:n,...}, resolvers:{...},
                purpose:{ text|null, source|null, from|null, note } }
numbers       the one record every count comes from (see below)
statements    { read:[string], notRead:[string], open:[string] }   sentences built from `numbers`
districts     { rule, prefix, trace, list:[{id,title,functions,boxes,entries,callsOut:[{district,calls}],callsIn:[...]}] }
journeys      { list:[journey], none:bool, noneNote, rejected:{...counts}, engineGaps:[gap],
                triggers:[{kind,label,fn,where,detail}], uncalled:[{fn,label,where}], reach:{functions,mappedFunctions,boxes} }
endings       { byOutcome:{success,neutral,refusal,failure,mixed}, failing:[failure], sites, note }
whoHears      { counts:{total,person,caller,event,log,someone,nobody,unknown,confident,notConfident,noClaim}, sentence }
switches      { items:[switch], count, withDefault, notRead, offByDefault, byKind, cannotSee:[string] }
triage        { questions:[question], gaps:{total,byKind,sample}, counts }
glossary      { terms:[term], count, withMeaning }
```

### purpose
`text` is the project's own words; `source` says where ("From the project's README (README.md)"). `text` is `null` and `note` says so when nothing was found. A page must show `source` beside `text`.

### journeys
A journey is one run from an outside trigger: an HTTP route arm, an event handler, a timer or thread, a command-line main, or exported API with no caller in the code. It crosses calls into the callee and back, follows a function value passed at a call site, never takes an error or handler arm, and takes one consistent arm per decision. Rejected: runs that stay in one function, runs that are mostly loops over lists written in the code, runs that never leave their file when others do. When nothing qualifies, `none` is true and a page says **"no main path found"**.

```
journey  { id, name, trigger:{kind,label,detail,fn,where},
           stats:{functions,files,steps,work,breaks,gaps,stepsShown,functionsShown},
           steps:[step], gaps:[gap], files:[path], functionsReached:[fid] }
step     { kind, depth, ... }
```
`kind` and its fields:

- `enter` `{fn, fid, where:"path:line", mapped, via, stuck?, note?}` a function is entered. `via` is `{kind:"trigger"}`, `{kind:"call"|"link", line, evidence:"map"|"scan"|"linked", tier, lit?}` or `{kind:"function value", line, name, evidence, by, where}` (a callback the callee runs). `evidence` says who found the hop: `map` the tool drew the road; `linked` the tool joined two ends by a literal (an HTTP path, a script name); `scan` the scanner resolved the call and the map draws no road there (an engine gap, also listed in `engineGaps`). `stuck` says why a function shows no steps of its own ("its own steps are only error handling", "the only way on is a failure, which a run does not take").
- `decision` / `loop` / `work` / `wait` / `end` / `step` `{line, title, plain, raw, box, pageBox, took?, notTaken?, outcome?}`. `title` fits a box (40 characters), `plain` is a sentence, `raw` is the tool's own phrase (provenance, never shown as the main text). `took` is `"yes"|"no"|"into the loop"`; `notTaken` lists the other arm(s) `{when, to}`. `work` is a box that writes, deletes, announces, calls out or responds. `end` carries `outcome`.
- `choice` `{line, name, options:[name], more?}` a call that may run any of several functions; each option that was followed is a nested `enter` below it. None is picked as "the" target.
- `folded` `{fn, fid, line, steps, work, via}` a call whose steps are not shown (the count says how many exist).
- `break` `{line, reason, gap}` a call that is not followed, with the reason. `gap:true` means the map lacks a road the run needed.
- `note`, `more` `{text}`.

Steps are in run order; `depth` is the call depth (a function value that a wrapper runs is shown one level in). A page draws them as an indented list or a ribbon; the chart a box belongs to is `pageBox` (look it up in `charts.json`).

`gap` (engine gap): `{path, line, from, to, note, fromLabel, toLabel, journeys:[id]}`: "at path:line, `from` calls `to`; the scanner resolves the call, the map has no road for it".

### endings  and failures
Each ending is classified from what the code shows: an HTTP status of 400 or more is a `refusal` (4xx) or `failure` (5xx); a raise is a `failure` (a `refusal` when the raised name is refusal-shaped); `neutral` exits or returns nothing; everything else is `success`. A box whose sites differ is `mixed`. An open end ("N calls not followed") is **not** an ending: charts draw it as a box of kind `open` with `ending:false`, and no count includes it.

`failure` `{box, page, fn, where, outcome, title, plain, whoHears:{value,detail,confidence}|null}`.

### whoHears
`value` is one of `person caller event log someone nobody unknown`. `unknown` always reads **"not known from the code"**. `nobody` appears only when the claim register proves it. `confidence` is the claim's: `confident` or `not-confident` (`none` when the register made no claim). Never write "none reach a person" unless `counts.nobody` equals `counts.total` and every claim is confident.

### switches
`switch` `{name, kind:"option"|"env"|"flag", useCount, uses:[{path,line,fn,box,test,negated}], default:{literal,path,line}|null, note, offByDefault:true|false|null}`. `default` is set only when the code writes one plain literal next to the name; otherwise `note` says "default not read" (and why). `offByDefault` is set only for names with a clear enable/disable polarity. `cannotSee` states what the list cannot see; a page shows it with the list.

### triage
`questions` are about the code, ranked first: `{id, kind, text, because, confidence, where:{path,line,fn}|null, evidence, rank}`. `kind` is one of `lost-wakeup never-sent swallowed-failure handler-nothing-can-reach flag-never-cleared flag-sticky written-never-read swallowed-unknown unreferenced wait-no-end`. `where` is `null` for a claim on no box ("on no box"). `gaps` are about the drawing (a decision with one way out drawn, a box with no way in, a call with several possible targets): `{total, byKind, sample:{kind:[{path,line,fn,box}]}}`. A page leads with `questions`, folds `gaps` behind its count, and never mixes them.

### glossary
`term` `{term, kind:"class"|"word", meaning|null, meaningFrom|null, usage:{files,names,examples,where}}`. `meaning` comes from a comment in the code and `meaningFrom` says which; when `meaning` is `null` the entry shows `usage` only. A term is never defined by the first box of a function.

### numbers
The only source of counts. A page must not count anything itself. `statements.read`, `.notRead` and `.open` are the sentences that quote them; a page may show those instead of writing its own. There is no ledger and no "Draft" state for a tool map.

```
read      files, languages, functions, boxes, roads, callRoads:{proven,may,linked}, districts, chartedFunctions, chartParts, outlines,
          claims, claimsConfident, claimsNotConfident, resolvers
notRead   functionsWithoutBoxes, unresolvedCalls|null, callsWithSeveralTargets, scanHopsUsedByJourneys, unreadFiles
endings   boxes, sites, byOutcome, siteByOutcome, failing
whoHears  (same as above)
entries   triggers, byKind, uncalledOther
journeys  kept, considered, rejected:{oneFunction,literalLoops,sameFile,duplicate,overQuota,rejectedTotal}, noMainPath
reach     reachedFunctions, reachedMappedFunctions, reachedBoxes     (from all entries, every road counted)
switches  found, withDefault, defaultNotRead, offByDefault
open      questions, questionsConfident, gapsInDrawing, claimsNotConfident
glossary  terms, withMeaning
purpose   found
```

## charts.json

```
functions  [{id, fid, label, long, path, line, district, boxes, callers, callees:[fn id], chart|null, anonymous?}]   one row per mapped function
charts     [{id, fid, fn, title(<=70), district, summary, parts:[{id, title, boxes:[box], roads:[road]}]}]
outlines   [{fn, fid, boxes:[{id,kind,title,plain,line,shape?}], roads:[road]}]    functions with no chart
stats      {chartedFunctions, chartParts, boxesDrawn, outlines}
```
`box` `{id, ref, shape:"own"|"card"|"stub"|"open"|"link"|"more", kind, rule, title(<=40), plain, raw, line, path, district, outcome?, effects?, entry?, target?}`. A `card` stands for a function called from here (`target` is its function id when it has a chart); `→?` marks a card the tool is not sure of. A `stub` is an exit folded into its decision. An `open` box is "continues: N calls not followed" and is not an ending. A `more` box names the callees beyond the first nine of one box. A `link` box opens another part of a long function.
`road` `{from, to, type, when, raw, tier:"proven"|"may"|"linked"|"open", via}`. `when` is plain ("yes", "no", "each time round", "calls", "if it fails"); `raw` is the tool's label.

## words.json

`{ "<map box id>": {title, plain, raw, page} }`. `title` (<= 40 characters) and `plain` replace the tool's phrases ("does store" becomes "Writes to <target> (<verb>)", "on *: print~" becomes "On any error: probably print it"). `raw` is the tool's phrase, kept as provenance. Anonymous functions are named by where they are assigned or passed ("callback passed to retryOnce", "handler for the "click" event"). No sentence contains a hash.
