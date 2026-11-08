# The rule engine

What happens after the readers (see `CONTRACT.md`): the loaded project goes in, the model and the claim register come out. Nothing here reads a source
file except to cite it (`outsideMentions`, the review) and nothing is learned or guessed: a rule that fires says which table row or graph edge fired.

```js
import { readSystem } from './index.mjs';
import { mapSystem, modelText, claimsText } from './mapsystem.mjs';
const sys = await readSystem(config);                  // readers + checkers
const { model, claims } = mapSystem(sys, { name });    // plain data
modelText(model); claimsText(claims);                  // the bytes written to disk: same sources, same environment, same bytes
```

`mapSystem` copies the reader documents first (the rules write what they resolve onto the functions they read), so the same `sys` can be mapped twice;
`{ clone: false }` hands the documents over. `sys.routeFacts` (from `routefacts.mjs`, which runs `routefacts.py`) carries the HTTP routes of Python
files; without it no route link is drawn.

## Stages, in order

| stage | module | what it does |
|---|---|---|
| resolve | `resolve.mjs`, `lookup.mjs`, `noreturn.mjs` | lexical call resolution (`how`), the checkers' answers merged in (`resolvemix.mjs`), effects keyed on the resolved definition (`effects.mjs`, `common.mjs`), the paths cut after a call that cannot return |
| links | `links.mjs`, `links_http.mjs` | connections that are not calls: script by name, event emit to listener, key written and read, HTTP client to route. Each carries both anchors; what was refused is kept with its reason |
| flow | `excflow.mjs`, `excpass.mjs`, `handlers.mjs` | where each raise lands, who calls whom, what escapes each function, what each handler does with the error |
| negative claims | `negclaims.mjs` | "nobody catches it" is `proven`, `unknown` or not claimed; the open ends are listed |
| reduce | `vocab.mjs`, `reduce.mjs` | control-flow graph to readable boxes: endings, decisions, loops, waits, handlers, steps |
| map | `mapbuild.mjs`, `roadpass.mjs` | boxes and roads: control-flow roads, call roads (looking through functions with no box), exception roads, each with its tier |
| model | `emit.mjs`, `confidence.mjs` | stages, the header (resolvers, environment, what was declined), the model text |
| claims | `findings.mjs`, `heard.mjs`, `heard3.mjs`, `claims.mjs`, `mainpath.mjs` | every statement the map makes, `confident` or `not-confident`, with its reason; the main path orders them |
| review | `review.mjs`, `review_check.mjs`, `overlay.mjs` | the questions an agent can research, the gate that re-checks its answers against the source, and the overlay of words and witnessed roads |

`flow.mjs` builds per-function flow charts from a finished model. `pyrt.mjs` holds the helpers that make JavaScript behave like the Python the rules were
first written in: code-point order and length, Python's truthiness and white space, `repr`, `round`, and the JSON text Python writes.

## Rules that keep the bytes the same

- Every sort is by code point (`cmp`, `sorted`); the default JavaScript sort is never used on text. `sorted(items, key)` calls `key` once per item, in order.
- A pair of strings is one key by `tkey`; a tuple of mixed values is told apart by its JSON.
- Maps and Sets keep insertion order, and the order things were found in is part of the input (`sys.order`).
- Output is written with `dumps` (sorted keys, no escaping of non-ASCII, the indent Python uses). A field that would be `undefined` is an error, not a dropped key.
- Counts, thresholds and limits are named constants with the reason beside them.

## Commands

`faultline map --source <root>` runs the readers and these rules, writes `map/model.json`, `claims.json`, `calls.json`, `review-index.json` and `story-index.json` into the project, and goes on to the reading and the page (`--no-page` stops before the page). `faultline review queue|check|view` reads them; a map whose sources changed since it was written is refused.

## What gets a box, and what draws a road

- **Every function in a resolved call is on the map.** A road needs a box at each end. A function that is the caller or the callee of a call the resolver pinned to a project function (`exact`, `self` or `typed`, also a `with` and a link) has at least one box. A function that decides nothing and does no work the map names gets one box for its whole body, `runs <name>` with `prov.landing: true`, so its calls start somewhere and the calls to it arrive somewhere. A call to a function with no box of its own used to be looked through (the road went on to the boxed functions it reached) and, when it reached none, was not drawn at all. That is gone: every such call has its road, with the tier the resolver gives it (`proven`, or `may` for overrides and replaceable names). A name that only matches by method name (`by-name`) is a candidate and never a road.
- **A function handed to a call is a road too** (`callbacks.mjs`). `retry(() => load(id))` hands a function over; the road runs from the box that holds the call to the box of that function: `prov.how: 'callback'`, `prov.callback: { kind, passed_to, arg, run }`. It is `proven` only when the function is written in the argument list or named by a name in scope, the callee is a project function, and the callee calls that very parameter somewhere in its body (`run: true`). A callee outside the project, or one that only stores or passes the parameter on, gives `may`. A function written inline has a box only when it is on the map for its own reasons (the owner joins so it has a road to arrive by); a named project function that is handed over joins like one that is called.
- **A condition that does work is a decision.** A test whose own code stores, deletes, sends or waits is boxed as a decision (`why: 'T'`) whatever its arms do, and an `elif` with such a test starts a decision of its own. The decision says what the test does in `prov.test_effects` and `prov.test_nodes`, and the effect claim cites the line of the call.
- **A call that never returns ends its arm.** An arm that stops at such a call is a folded exit of class `raise:*` (the type is not read) or `X` (a call that exits the process), never `continues`. The work written after it in the same block is not part of the graph: no road, no effect.
- **A `with` whose manager swallows.** When the manager is a project class whose `__exit__` returns the constant `True` on every path that returns, an exception raised in the block stops at the `with` and the code after it runs. The graph reader gives every `with` a join node; `swallow.mjs` adds the edges for such managers only.
- **An ending that leaves through a `finally` has a road to it.** A return or an escaping raise that passes a `finally` block gets a road (`prov.via_finally`) to the first boxes in that block, and `prov.runs_finally` on an ending lists the lines of those blocks. A `finally` with no box of its own is named there and its calls hang off the endings, as before.
- **A road to a stub with overrides is `may`** (`prov.stub_with_overrides`): the method named is abstract or only raises `NotImplementedError`, and a subclass in the project supplies the body that runs.
- **Labelled jumps** (TypeScript and JavaScript): `break label` and `continue label` land on the statement the label names; a labelled block is left by `break label`. An unlabelled `break` lands on the nearest loop or `switch`, an unlabelled `continue` on the nearest loop.
- **Box ids.** `<file path without extension, / as ., characters outside letters, digits, _ and . as _>.<qualified name>.<code>`. Two functions whose stems come out the same (`a-b.ts` and `a_b.ts`, `x.ts` and `x.js`, `a.b.ts` and `a/b.ts`, names that differ only outside ASCII) each get `-` and the first eight hex digits of a sha256 of their full function id after the stem. A function nobody clashes with keeps the plain id and does not change when a clash appears elsewhere. If two ids still meet, a counter `-2`, `-3` is added in the order the boxes are made.
- **Text is cut on code points**, never inside a surrogate pair, in the readers and in the rules. A file whose syntax tree is too deep for the stack (or a program the TypeScript checker cannot bind for that reason) is left out, or read without the checker, and the header lists it under `unread`.
- **A default export is named by whoever imports it**, so a function that is the default export of its module is never "nothing calls it" with confidence. The search of files outside the mapped folder also reads extensionless build and launch files (`Makefile`, `Dockerfile`, `Procfile` ...) and the CI and container folders (`.github`, `.gitlab`, `.circleci`, `.devcontainer`, `.husky`).

Fields added to the output (none was removed or renamed): on boxes `prov.landing`, `prov.test_effects`, `prov.test_nodes`, `prov.runs_finally`; on roads `prov.how` / `prov.basis` / `prov.callback` / `prov.role` for callbacks, `prov.via_finally`, `prov.stub_with_overrides`; claim reasons `callback-called-by-callee`, `callback-handed-over`, `stub-with-overrides`; folded exits of class `X`. In the reader documents: `ai` (the name handed over at each argument position) on call ops, `jp` on `with` ops, `dflt` on functions, `stop` on a file that was not read. In the loaded project: `cbr` on call ops, `nr` and `sw` on nodes.
