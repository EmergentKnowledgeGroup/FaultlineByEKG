# Parcelworks: answer key

Parcelworks is an invented parcel job runner. It exists so Faultline has one small, runnable system to test and demonstrate against. Nothing here is a claim about any real system.

Line numbers below are for the checked-in files. If you edit the code, regenerate the fixtures (see "Run it") and re-check the model with a symbol and line check.

## Layout

```
parcelworks/      Python, stdlib only, about 465 lines
  config.py       env settings read at call time (the switches)
  schema.py       JobStatus, Outcome, Refusal, Parcel
  intake.py       validate + accept (refusals, duplicate check, fast lane)
  jobqueue.py     SQLite queue: enqueue, claim, reclaim_expired, complete, fail, hold, release_hold
  handlers.py     route (customs / address holds, carrier booking)
  worker.py       Worker.process_one and the Worker.run loop
  report.py       summarize, render, write_report, publish
  cli.py          submit / work / release / report commands, main
web/              TypeScript, about 110 lines: status API client
tests/            unittest, 35 tests; make_fixtures.py regenerates the two fixtures
fixtures/         coverage.json (coverage.py JSON, branch coverage), address-hold.walk.jsonl
.faultline/model/ the hand-written model: 6 fragments, no ledger, no layout
```

## Run it

```
cd examples/toy
python -m unittest                      # 35 tests, all pass
python tests/make_fixtures.py           # rewrites both fixtures (Python 3.11+, needs coverage.py for the coverage half)
tsc --noEmit --strict --target es2022 --lib es2022,dom --module esnext --moduleResolution bundler web/client.ts web/status.ts
```

The last command was run with the TypeScript package from the repo root and printed nothing (clean).

## What the system does

Intake validates a parcel (six refusal codes) and enqueues it. A durable SQLite queue hands jobs to a worker under a lease. The worker routes each parcel: book a carrier, or park it in hold. A failed carrier call retries with exponential backoff (2, 4, 8 s, capped at 300) up to MAX_ATTEMPTS, then fails for good. An expired lease is reclaimed. A report counts outcomes and writes a file.

Switches (all read in `config.py`, one per function): FAST_LANE (off by default, line 7), MAX_ATTEMPTS (12, default 4), MAX_WEIGHT_G (17, default 30000), LEASE_SECONDS (22, default 30), BACKOFF_BASE_S (27, default 2), CUSTOMS_LIMIT_CENTS (32, default 50000), PARCELWORKS_DB (37). The TypeScript side reads POLL_LIMIT at `web/client.ts:6`.

Enums: JobStatus (`schema.py:6-11`, 5 values), Outcome (`schema.py:14-19`, 4 values), JobState in TypeScript (`web/status.ts:2-8`).

Entries: `cli.py::main` (main guard at line 69), the four `cmd_*` commands, `Worker.run` (the worker loop), `web/client.ts::StatusClient.*`.

## The five planted items

### 1. A hold whose only exit waits for a later request, and one branch is never cleared

- Where: `handlers.py::route` line 29 parks a ZZ postcode as hold reason "address". `jobqueue.py::Queue.hold` (128-133) writes the hold. The only code that leaves hold is `Queue.release_hold` (135-145), and its only caller is `cli.py::cmd_release` (23-31). `cmd_release` calls it only when `hold_reason == "customs" and customs_cleared` (line 28). An address hold gets `still on hold (address)` at line 31, every time.
- Model: `trouble.hold_address`, `trouble.release_refused`, routes `r_hold_address_release` (inferred, a later request) and `r_release_other` (return). Loop `l_hold_address`. Path `address_stuck`.
- Expected candidate: `can-only-go-back:trouble.hold_address` (one road in from `work.route`, one back from `trouble.release_refused`; its only exit comes straight back).
- Negative control: `trouble.hold_customs` has the same wait-for-a-request shape but `trouble.release` has a real exit to `queue.pending` (`r_release_ok`). It must not be called a candidate for the same reason.
- Evidence: `tests/test_worker.py::test_address_hold_stays_held` runs it; `fixtures/address-hold.walk.jsonl` ends `stuck:trouble.hold_address`.

### 2. An outcome declared in an enum and never produced

- Where: `schema.py` line 19, `Outcome.RETURNED = "returned_to_sender"`. `report.py::summarize` (line 10) builds a row for every Outcome member, so the report prints `returned_to_sender 0` every time. No code assigns a parcel to it.
- Model: `report.returned`, an end box with no road in (the only box besides the entry `web.submit` with none).
- Expected candidate: `declared-never-produced:report.returned`.
- Negative control: the other three Outcome values and all five JobStatus values are produced by code (the queue binds JobStatus values into its SQL on purpose, so a name search finds each member written).

### 3. An ending no test reaches

- Where: `worker.py` line 32, `return "lease_lost"` in `Worker.process_one`. It happens when `complete`, `fail` or `hold` finds the lease token gone (the lease expired and another claim replaced it). Tests never let a lease expire while a worker holds the job.
- Model: `work.lease_lost` (end, neutral). Roads in: `r_complete_lost`, `r_fail_lost`. `Queue.hold` returning False also ends here (worker.py line 28); that road is not drawn.
- Expected candidate: `ending-no-test:work.lease_lost`.
- Proof it is honest: `fixtures/coverage.json` lists `parcelworks/worker.py` missing_lines `[32]` and missing_branches `[[31, 32]]`.
- Other uncovered lines in the fixture (incidental, not planted): `cli.py:70` (the main guard call), `jobqueue.py:90-92` (claim's rollback and re-raise), `jobqueue.py:120` (`fail` answering "stale", a road into item 3), `report.py:44-46` (the OSError branch of item 4). A good analysis may mention the last two as part of their planted items. The first two are ordinary noise.

### 4. A retry loop with no limit

- Where: `report.py::write_report` (35-46). `while True:` at line 38, an `except OSError` at line 44, an attempt counter and a growing `time.sleep` at lines 45-46, and no exit except success.
- Model: `report.write` and `report.busy`, loop `l_report_write` with an empty `limit`.
- Expected candidate: `no-limit-loop:l_report_write` (say "no limit shown").
- Negative controls (bounded retries, must not be flagged): the queue retry (`Queue.fail`, line 121, MAX_ATTEMPTS), the lease reclaim (each claim adds an attempt, `reclaim_expired` fails the job on the last one), `web/client.ts` `StatusClient.call` (`for` up to FETCH_TRIES, line 23) and `waitForTerminal` (`for` up to POLL_LIMIT, line 57).
- Looks like a loop but is a service loop, not planted: `worker.py::Worker.run` (line 39) runs until `max_ticks` or `stop_when_idle`, and a service passes neither. The model gives it a `limit` that says so. An analysis may list it as a loop; it should not rank it above item 4.

### 5. A straight happy path a lazy map would show

- Where: web client -> `cmd_submit` -> `validate` -> `accept` -> `Queue.enqueue` -> `Queue.claim` -> `route` -> `book_carrier` -> `Queue.complete` -> `summarize` -> `render` -> `write_report`. Most functions on it have one caller and one callee.
- Model: path `main` (22 boxes). A map that drew only this would show a calm chain and hide the refusals, the retry loop, both holds, the lease loss and the report retry.
- What it tests: gate S1 (a straight list while the census has 10+ decision branches) and the "unglamorous stages stay visible" bar: stage 4 "Retry and hold" must stay on the whole-system view.

## The model (`.faultline/model/`)

35 boxes, 47 routes, 5 stages (Intake 10, Queue 6, Work 6, Retry and hold 7, Report 6), 5 paths (`main` first), 5 loops, 10 terms. Every cited symbol exists and every cited line is inside its function. Every Python module is cited; `parcelworks/__init__.py` and `web/status.ts` are excluded with a reason.

- Fragments merge in filename order: `00-system` (system, stages, paths, loops, terms, modules), then `10-intake`, `20-queue`, `30-work`, `40-trouble`, `50-report`.
- Several boxes cite the same function on purpose (real systems do). Map a step to the box whose cited line is nearest, not just the first box that cites the function. Shared functions: `validate` (4 boxes), `accept` (4), `route` (4), `Queue.enqueue` (3), `Queue.claim` (3), `Queue.fail` (3), `Worker.process_one` (3), and two each for `Queue.hold`, `Queue.reclaim_expired`, `Queue.complete`, `cmd_release`, `Worker.run`, `write_report`, `summarize`.
- Inferred routes (lower trust, no call edge proves them): `r_web_submit` (no server in the toy), `r_pending_loop` (a table state), `r_done_report` and both `r_hold_*_release` (later operator requests).
- No ledger is written. Expect `check --finished` to print census gaps (B1 and the like) and `check` in draft to print them as gaps, not refusals.
- Box ids named like the ones above are stable; do not rename them without updating this file.

## The walk fixture

`fixtures/address-hold.walk.jsonl` is a real traced run (`sys.settrace`, first body line of each parcelworks call), not hand-typed. Label SAMPLED, controls not passed. Two outcomes: `end:report.saved` (a normal parcel, 22 steps) and `stuck:trouble.hold_address` (a ZZ parcel held, then two release requests answered `still on hold (address)`, 24 steps). The `unexplored` list names four boxes this run never reached.

- The `pin` is a sha256 over the sorted per-file hashes of `parcelworks/*.py`. It is not promised to equal the extractor's tree pin; an importer may warn on a mismatch and should still read the steps.
- Two traced functions are cited by no box on purpose: `Queue.get` and `Queue.all_jobs`. Expect them to come back NOT MAPPED.
- The trace calls `accept` right after `cmd_submit`. Whether that reads as "map is missing this route" depends on how a step is assigned to one of the four boxes that cite `accept`.

## Words to avoid in anything built from this toy

Use "candidate", "not drawn" and "no limit shown". Do not call item 1 a dead end or a bug, and do not call item 4 unbounded.
