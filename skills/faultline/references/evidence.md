# Adding evidence

The atlas stands on its own. Evidence is a switch on top: off by default on the page, and it lights both the page and the agent view. Every source writes one format, a `.walk.jsonl` file, and the map never imports the tool that made it.

On a tool map (`faultline map`), `walk add` was tried: a walk that reaches a box makes `where` say "level: seen", and `faultline build` puts the walk on the page (it rebuilds the page with the Reader, from the map already there). The other importers below were not tried on a tool map. Run `faultline map` again to refresh a map whose code changed.

## Sources

```
faultline coverage import coverage.json            # coverage.py, lcov or istanbul; makes a walk
faultline walk add run.walk.jsonl                  # any walk file
faultline walk list                                # what the loaded walks say
faultline evidence import-logs logs.jsonl          # structured logs or spans; makes a walk
faultline evidence import-statechart DIR --map mapping.json   # a model checker's report folder; makes a walk (below)
faultline evidence --help                          # logs, statechart and explorer imports
```

`walk add` stores a cleaned copy of the file you give it (paths repo-relative or a file name, home folders, emails and secrets masked, the words of a reason kept) and leaves your original alone.

Coverage lights a box only if a cited function's BODY ran, because a `def` line runs at import. A step that maps to no box is listed as not mapped, never guessed. Two steps in a row with no route between them are listed as "the map lacks this road". That list is often the most useful thing a walk produces: it fixes the map.

## What a walk says

```jsonc
{"walk":1,"tool":"coverage.py@7","kind":"run|test|modelcheck|explorer|manual","pin":"<git sha or tree hash>"}
{"label":"NONE|SAMPLED|BOUNDED_INCOMPLETE|EXHAUSTIVE_WITHIN_MODEL","controls_passed":false,"explored":[],"unexplored":[{"at":"box or symbol","why":"budget cut"}]}
{"outcome":"end:<box>|stuck:<box>|error|unknown","strength":"observed|replayable|proved-in-model|claimed","reason":"the tool's own words","witness":"replay file or null","count":1,"steps":[{"ref":"file:line","sym":"fnId","tag":"box alias or stage name"}]}
```

Levels: **drawn** by default; **suspected** from a candidate; **seen** from an observed walk or body coverage; **proved** from a replayable or proved-in-model walk. Only `EXHAUSTIVE_WITHIN_MODEL` with `controls_passed: true` may say "no violation found". A changed function marks its own boxes stale, not the whole map.

## A model checker's report (`import-statechart`)

A rule check of a model of the code (a TLA+ model run through TLC, for example) can come back as a folder. `import-statechart DIR --map mapping.json` reads it and writes one walk of kind `modelcheck`, with one outcome of strength `proved-in-model` for each rule that breaks. The folder holds:

- `report.md` (required): a title line `# Name`; `TLC reached N states and M steps`; for each broken rule a section `## <rule> breaks` with its path as numbered lines (`0. state`, `1. action: state`) and, when the run never ends, `The run stops in "state" forever.` or `The run loops through <states> forever.`; then `## Rules that hold` and `## Rules not checked`, each a comma-separated list. A rule whose name contains "deadlock" is a stuck outcome at the last state.
- `chart.mmd` (optional): a Mermaid state chart whose states are `s0: Label` or `state "Label" as s1`, so the report's labels can be matched to chart ids.
- `<Name>.tla` (optional): its hash becomes the walk's pin when the mapping gives none.

The mapping file ties states to box ids. A state with no mapping stays unmapped and is listed, never guessed:

```json
{ "states": { "Claimed": "queue.leased", "s3": "queue.done" },
  "patterns": [{ "match": "^Hold", "box": "trouble.hold_customs" }],
  "tool": "statechart@tlc", "controlsPassed": false }
```

The label is `EXHAUSTIVE_WITHIN_MODEL` only when TLC reached its states and nothing was left unchecked; it still says "no violation found" only when `controlsPassed` is true.

## Writing an explorer

An explorer walks the code's real decision code through every reachable state, to find what no test reached. Faultline's runner speaks JSON lines over stdin and stdout, so the adapter can be in any language. See `src/evidence/explorer/PROTOCOL.md`, and `examples/toy/explorer_adapter.py` for a worked one.

The ops are `manifest`, `initial`, `actions(state)`, `apply(state, action)`, `classify(state)`, `identity(state)`, `where(state)`, `controls` and `selftest`. The rules that keep it honest:

- Identity is a hash of the full state bytes. Labels never merge or skip states.
- Controls run first: known-answer states, including a known stuck one. A checker that calls everything or nothing stuck is refused.
- A finding counts only when its action list replays.
- Coverage labels are computed from facts, never claimed by the adapter.
- Offline, no child processes, writes only in its run folder.

Start from the map: its candidates are the first places worth pointing an explorer at. Its results return as a walk, so the page shows what was reached, what got stuck, and what nobody checked.

## What stays out of the page, and out of a stored walk

Walks from logs, spans or any other tool carry the machine they ran on, so the page and `atlas.agent.json` take only what the scrubber (`src/evidence/scrub.mjs`) can make safe:

- Every path is repo-relative, or just a file name when it matches nothing in the code. A home folder (the user's folder on Windows, macOS or Linux, a name with spaces included) becomes `<home>` and the name is never kept. `../../home/bob/x.py`, `Users\bob\x.py` and a network share address such as `smb://host/share/bob/x.py` count too.
- Emails are masked.
- These secret shapes are masked: the value after `password`, `secret`, `token`, `api key`, `auth` or `authorization`; `Bearer` and `Basic` credentials; `sk-` keys; GitHub, Slack and Google API keys; AWS access key ids; JWTs; private key blocks; credentials inside a URL; webhook URLs; and any run of 32 or more hex digits. A secret in any other shape passes through, so read the page before you share it.
- Tags and tool names stay as written (only paths, emails and the secret shapes are cut from them), and so does the name part of an outcome target such as `stuck:NAME`. The scrubber cannot tell a person's name from any other word, so keep names out of a hand-written walk's tags, tool names and outcome targets.
- The text of a log line (a walk's `reason`) is left out. `build --keep-messages` puts that text back, with paths and the secret shapes still cut but emails left alone: then the page holds your log text, so read it before you share the page.
- `walk add FILE` stores a cleaned copy in `walks/` (the same paths, home folders, emails and secret shapes, the words of a reason kept) and leaves your original alone. The words of a reason stay, so read it before you commit it.
- `evidence import-logs` writes `walks/logs-*.walk.jsonl` and `walks/spans-*.walk.jsonl`, which keep the message text (paths and the secret shapes cut, emails left alone). `init` writes a `.gitignore` that keeps those two kinds out of git. A project that was not made with `init` has no such file: add the two lines yourself before you commit.
- `sourceBase` (or `--source-base`) is written into the page as given. A `file:///...` base puts a path from your machine into it, so use a web URL when you share the page.
- `facts.json` and `signals.json` remember the source folder as `..` steps from the project folder, never as a full path, so a project committed with its code carries no home folder. The page from `build` holds no source text unless you pass `build --excerpts`.
