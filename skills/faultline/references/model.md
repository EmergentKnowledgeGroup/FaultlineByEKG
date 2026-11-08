# Writing the model

This is the format of a map written by hand. It is how a whole story is written (`references/story.md`), and it is what `faultline story check` reads. You do not need it to get a map: `faultline map` makes that. Do not write into a project folder that `faultline map` made.

The model is JSON in `model/*.json`. Files merge in name order, arrays concatenate, objects merge, duplicate ids refuse. Write several small files, not one big one, so one mistake stays small and several agents can each own one.

`examples/toy/.faultline/model/` is a complete worked example. Read one stage file before you write yours. `faultline story check` reads each box's `id`, `kind`, `refs` and `outcome`, and each road's `from`, `to`, `type`, `when` and `refs`, and carries the rest through. The gates below (`faultline check`) apply only when you build the story's own page.

## System and stages (`00-system.json`)

```json
{ "schema": "faultline.model/1",
  "system": { "name": "", "tagline": "one line", "summary": "what it does, in a short paragraph", "purpose": "what counts as success" },
  "stages": [{ "id": "s_queue", "title": "Queue", "blurb": "Jobs wait here until a worker claims one.", "order": 2 }],
  "terms":  [{ "term": "lease", "meaning": "A time-limited claim on a job.", "refs": [] }] }
```

Stages tell a story in order: how work arrives, what happens to it, how it leaves, what happens when it goes wrong, how people run it. Use the owner's layer names when they fit the code. Failure, safety and operations get their own stages rather than a footnote. Aim for 6 to 16 stages.

## Boxes

```json
{ "id": "work.route", "stage": "s_work", "kind": "decision",
  "title": "Route the parcel", "handle": "route",
  "plain": "A declared value over the customs limit without papers is parked, and so is a ZZ postcode. Everything else goes to the carrier.",
  "status": "default-on", "switch": "switch:CUSTOMS_LIMIT_CENTS",
  "refs": [{ "path": "parcelworks/handlers.py", "symbol": "parcelworks/handlers.py::route", "line": 26 }],
  "inputs": ["parcel dict"], "outputs": ["a Verdict"], "failure": "" }
```

| Field | Rule |
|---|---|
| `id` | Stable and dotted, prefixed by stage so ids never collide. Never reuse one for a different thing |
| `kind` | `step` `decision` `wait` `end` `store` `external` `gate` |
| `title` | Target 34 characters, hard limit 40. A verb phrase for actions, a noun for states. Cut words, never shrink type |
| `handle` | The code's own name for this (function, flag, table, term). Copied from the code or its docs, never invented. Leave it out if there is none |
| `plain` | At most 260 characters. Says what happens and why it matters, in plain words, keeping the code's terms |
| `status` | `live` `default-on` `off` `test-only`. Name the `switch` when it is off or default-on: the census id `switch:NAME`, or for what the census cannot see `option:<name>`, `env:<NAME>`, `flag:<--name>`, `setting:<name>`, `owner:<what they do>`. Name what turns it on, not a value it merely tunes |
| `refs` | At least one. `symbol` must exist in `facts.json` and `line` must fall inside it. `check` refuses otherwise |
| `outcome` | For `end` boxes only: `success` `failure` `refusal` `neutral` |
| `partName` | Optional. Names the chart part this box falls in, when a big stage is split ("Hold and release"). Otherwise the part takes the title of its first box |

Function ids are `<path>::<qualname>`. Look them up, do not reconstruct them: a class method can carry a suffix such as `Worker.run~2`.

## Who hears about it, and what a part does

Both are maps at the top level of any model file, usually `model/96-heard.json` and `model/95-parts.json`:

```json
{ "heardBy": { "trouble.hold_customs": { "by": "person", "how": "Held notice shown on the parcel page" } },
  "partNotes": { "trouble.hold_customs": "Parcels stopped for missing papers, and how they get released" } }
```

- `heardBy.by`, the furthest the news goes: `person` (someone using the program is told); `outside` (sent to a party outside the program); `event` (published for whoever listens: an event, a metric, a webhook); `caller` (thrown or returned to code that called, and that caller is arbitrary or out of scope); `log` (only written to a log); `nobody` (no trace at all); `unclear` (the code doesn't settle it).
- `heardBy.how`: a short phrase with the evidence, under 70 characters. "logger.warning, then returns None".
- Every failure and refusal end box gets an entry (`check` warns W-heard). Any other box may have one: a failure can be heard about while the story goes on. Only what the code shows: follow the error up to whoever catches it, never infer from the box's title.
- `nobody` and `log` failures appear on the page under "Failures nobody is told about". They raise no gate.
- `partNotes`: keyed by any box in the part, at most 110 characters, what that chart part does. Not a repeat of its name.
- `waitsFor`, keyed by wait box, usually in `model/97-waits.json`: `{ "waitsFor": { "queue.block": { "on": "machine", "how": "BLPOP with no timeout" } } }`. `on`: `person` (someone has to act), `machine` (another part of this system: a lock, a queue, another worker), `outside` (a service outside this system), `time` (a timer that ends by itself). Say in `how` whether a timeout exists. A wait for a person goes in its own group on the page and isn't counted as something to look at. Leave a box out if the code doesn't settle it.

## Routes

```json
{ "id": "r_route_customs", "from": "work.route", "to": "trouble.hold_customs", "type": "forward",
  "when": "Value over limit, no papers",
  "why": "declared_cents is above CUSTOMS_LIMIT_CENTS and the parcel has no customs_cleared mark.",
  "refs": [{ "path": "parcelworks/handlers.py", "symbol": "parcelworks/handlers.py::route", "line": 27 }],
  "inferred": false }
```

- `type`: `forward`; `return` (loop back or retry, drawn red and dashed); `record` (writes evidence or a side effect); `deliver` (hands something to a person or outside).
- `when`: the condition, at most 28 characters. It may not start with a describing verb (checks, handles, manages, processes, uses, supports, can, may, might). May be empty only when the box has one exit.
- Return routes close loops. Check that each loop you describe has one. Also use `return` for a thrown error or an answer going back to its caller.
- An `end` box has no forward road out, and a `decision` has at least two exits (`check` warns: `W-end-exit`, `W-decision-one-exit`).
- `inferred: true` when no code path proves the road: events, queues, config, a person doing something later.

## Loops and paths

```json
"loops": [{ "id": "l_retry", "title": "Retry with backoff", "blurb": "", "boxes": ["trouble.fail", "queue.claim"], "limit": "max_attempts on the job" }],
"paths": [{ "id": "main", "title": "Main path", "boxes": ["..."], "blurb": "" }]
```

The first path is the happy path: the page and the placer use it as the spine, so it should run from where a request starts to where it ends. Give start-up its own path. A path may pass through a box twice, because calls come back. Files merge in name order, so put it in `00-system.json`. Add a path for each story a person would want to follow, such as a failed job, an operator's day or a refusal. Consecutive boxes in a path need a route between them. A `limit` must say what actually bounds the loop, or stay empty.

## The ledger

Every required census row needs one line. `faultline worklist <stage>` lists the rows left, or read `census.json` (endings not marked `low`, branches with `weight: decision`).

```json
"ledger": {
  "end:pkg/q.py::Worker.run:0": { "box": "work.lease_lost" },
  "branch:pkg/q.py::Worker.run:3": { "route": "r_idle_loop" },
  "branch:pkg/q.py::parse:1": { "merged": "intake.validate", "why": "Six field checks that all refuse the same way" },
  "end:pkg/util.py::fmt:0": { "excluded": "Formats a label for a log line; never reaches a caller" }
}
```

- `box` or `route` means this row IS that box or route. Read the code before you say so.
- `merged` needs a `why` per row once a box takes more than 8. A box absorbing 25 rows is a warning that it should be split.
- `excluded` needs a real reason. More than a quarter of a census kind excluded is refused.
- Do not fill the ledger with a script that assumes "row is in a cited function, so it is covered". That is the job shrinking again. A script may help you type; you read the rows.

Modules must be cited by a box or excluded in the model: `"modules": { "pkg/vendor_shim.py": { "excluded": "Thin wrapper, no logic" } }`.

## Refusals you will see

`check` prints `REFUSE <code> <what>: <offender>. Fix: <how>.`

| Code | When | Means |
|---|---|---|
| G1 | always | Cited symbol or line is not in the facts |
| G2 | always | Box has no refs |
| G3 | always | Route, path or loop points at something that does not exist |
| G4 | always | Duplicate id |
| G5 | always | A box with 2+ exits has an exit with no condition |
| K1 | always | Missing kind, status, outcome or route type |
| T1 | always | Text over its limit, or `when` starts with a describing verb |
| L1 | always | Layout has overlaps, routes through boxes and so on. Usually fixed by re-running `place`; otherwise report it |
| B1 B2 | finished | Ledger gaps, too many merges or exclusions |
| M1 | finished | A module neither cited nor excluded |
| S1 S2 | finished | The map is a straight list, or has no return route though the code has loops |
| E1 | finished | Fewer end boxes than distinct outcome values |
| A1 | finished | A candidate is neither kept as a suspect nor dismissed with a why |

`check` prints the count per code. `check --stage <id>` prints every offender in one stage, and `receipts.json` lists them all.

Fix the model. If a refusal is wrong, say so in your hand-off rather than working around it.
