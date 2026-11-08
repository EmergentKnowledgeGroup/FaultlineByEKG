# Explorer adapter protocol

An adapter is any program that answers JSON lines on stdin/stdout. The runner (`runner.mjs`) drives it and knows nothing else about your system. This is CONTRACTS section 9 written out, plus one extra op (`selftest`).

One request per line `{"id":1,"op":"apply","state":{...},"action":"tick"}`, one reply per line `{"id":1,"ok":true,"result":{...}}` or `{"id":1,"ok":false,"error":"why"}`. Replies come in request order. States are opaque JSON: the runner stores and hands them back untouched.

| op | request | result |
|---|---|---|
| `manifest` | | `{protocol:"faultline.explorer/1", adapter, version?, code, input, guard:{selftest:true}}`. `code` is a hash of the code under test, `input` a hash of the config. Compute them at call time: the runner asks again on resume and refuses if either moved. |
| `selftest` | | `{network:true, subprocess:true, writes:true}`, each true meaning "I tried it and it was refused". Required unless the run is started with `--allow-unguarded`. |
| `initial` | | `{states:[state,...]}` |
| `actions` | `state` | `{actions:[{id:"..."},...]}` (plain strings also work). Ids are stable; the runner sorts them. |
| `apply` | `state`, `action` | `{state}` or `{rejected:"reason"}`. Pure: same input, same output. |
| `classify` | `state` | `{class, reason}`; class is `ok`, `wait`, `end`, `stuck`, `invalid` or `cut`. `ok` and `wait` are expanded; the rest are not. `reason` is a short stable code. |
| `identity` | `state` | `{bytes:"..."}` or `{b64:"..."}`: the exact bytes of the whole state. Two states are the same state only if these bytes are equal. |
| `where` | `state` | a box id or `path::symbol` (a bare string), or `{at}`; `""` when the state sits at no box. |
| `controls` | | `{controls:[{name, state, expect}]}`. Known-answer states. Needs at least one `expect:"stuck"` and one expecting `ok`, `wait` or `end`. |

## What the runner guarantees

- Controls run first. If any known answer is wrong (a checker that calls everything stuck, or nothing stuck) the run is refused and nothing is written as evidence. The refusal is in `<run>/refusal.json`.
- Search is breadth first, so the first witness for a finding is a shortest one.
- Identity is the sha-256 of the full bytes. On a hash hit the bytes are compared; equal bytes mean seen, different bytes mean a collision and both states are kept. `where`, `class` and labels never merge or skip a state.
- Budgets: `--max-states`, `--max-evals` (one per `apply`), `--max-seconds`. A budget stops the search with states still open; the label is then `BOUNDED_INCOMPLETE` and the open places are listed as unexplored.
- Resume (`--resume`) reads the run folder and refuses if the manifest hash changed. A run folder that already holds a run refuses a plain start (`--fresh` clears it).
- A finding (a `stuck` or `invalid` state, or an `end` place) is written only after its action list is replayed in a second, fresh adapter process and reaches the same class, reason and state identity. A finding that does not replay is listed in `run.json` under `unreplayed` and is not evidence.
- The label is computed by the runner from what it counted: `NONE` (no states), `SAMPLED` (start states only), `BOUNDED_INCOMPLETE` (budget hit, states left open, a `cut` state, an unverified guard, or a finding that did not replay), `EXHAUSTIVE_WITHIN_MODEL` (nothing open, nothing cut, guard verified, every finding replayed). `controls_passed` is true only when the controls passed, the checker did not call every explored state stuck, and every finding replayed. The adapter cannot claim a label.
- Output is a walk file (`kind: "explorer"`) plus one witness JSON per finding, next to it. Each outcome carries `granularity:"state"`: its steps are places the system rested at, so one action may cross several boxes, and the importer asks only whether a chain of drawn routes joins them.

## The offline guard

The runner starts the adapter with a scrubbed environment (no proxies or credentials, home and temp inside the run folder, cwd in the run folder). That is hygiene, not a sandbox: the adapter must refuse network, child processes and writes outside its run folder itself, and prove it with `selftest`. `examples/toy/explorer_adapter.py` does it with a Python audit hook (about 30 lines, stdlib). The runner re-asks `manifest` on resume and in the replay process, so code that changes under the run is caught.

## Run it

```
node src/evidence/explorer/runner.mjs --run <run dir> --out <project>/walks/explorer.walk.jsonl \
     [--facts facts.json] [--model-dir <project>/model] -- python -I -B examples/toy/explorer_adapter.py --parcels zz
node src/evidence/explorer/runner.mjs --replay <walk dir>/explorer.witness/01-....json -- python -I -B examples/toy/explorer_adapter.py --parcels zz
```

Exit 0: finished (findings or not). Exit 3: refused. Exit 1: the replay did not reproduce, or a crash.

Out of v1: parallel workers, eventual-termination claims, witness shrinking, multi-actor systems.
