# Working the review queue

The tool makes a claim about the code for every box, road and ending. Some of them it is not sure of. `faultline review` turns those into questions, and checks your answers against the code. This is the part a model is good at: reading a few lines and saying whether they show what the question asks.

You do not map. You do not decide what the code is for. You answer "is this actually what it says it is".

## The three commands

```
faultline review queue --source <folder> [--limit N] [--out queue.json]
faultline review check --answers answers.json --source <folder>
faultline review view  --source <folder> [--without-agent] [--out file.json]
```

`<folder>` is the folder you gave to `faultline map`. Add `--project DIR` if the project is not in `./.faultline`. If a file the map read changed after the map was made, all three refuse and say to run `faultline map` again. A file added since is not noticed. They read only inside `<folder>` and skip links that leave it. The check is a drift check, not a tamper check: a `.faultline` folder that came with a repo you cloned is someone else's input, so run `faultline map` yourself before you trust it.

## A question

```
#3 [main-failure] q:r:parcelworks.jobqueue.Queue.claim.s0->...h3-h0:if it fails
  Q: Can the call at parcelworks/jobqueue.py:79 raise an error that the handler (handler at line 90) takes?
  answers: yes-can-raise | no-cannot | cannot-tell
    parcelworks/jobqueue.py:75 |         """Lease the oldest ready job ...
    parcelworks/jobqueue.py:79 |             row = self.db.execute(
```

- The id after the tier (`q:r:...`) is the `item`. Copy it exactly.
- The tier says how much it matters: `main-failure` (on the main path and about a failure), `main`, `failure`, `rest`. The queue is in that order. Start at the top.
- The lines are what to read first. Open the file for more.
- `answers` is a closed list. You must pick one. `cannot-tell` is always allowed.

## Your answers file

```json
{ "answers": [
  { "item": "q:d:parcelworks/intake.py::accept:39:queue.enqueue:maybe:emit",
    "choice": "yes", "cite": "parcelworks/jobqueue.py:68", "quote": "def enqueue(self, parcel" },
  { "item": "q:y:web.client.StatusClient.submit.e1", "choice": "cannot-tell" }
] }
```

- Only these four keys: `item`, `choice`, `cite`, `quote`. Any other key refuses the answer.
- `cite` is `path:line`, relative to the source folder, a line that exists.
- `quote` is text from that line (3 to 200 characters). The tool checks the line holds it.
- `cannot-tell` needs no cite and no quote.
- Put all your answers in one file. Each `review check` replaces the last stored result.

## What each kind of question accepts

A positive answer needs a cited line that shows it. These are the kinds, and what the tool looks for in the line.

| Kind of question | Positive answer | The cited line must show |
|---|---|---|
| Is this call a store, a delete, a message, a reply, a wait or a call that leaves the program? | `yes` | An API that does it (a file write, a queue, a send). A line that is only the call itself does not count. |
| Is this error caught somewhere? | `caught-at-cited-line` | A handler: `except` or `catch`. |
| Is this function called from somewhere the map does not show? | `called-at-cited-line` | A line that names it, and is not its own definition. |
| Is this name used anywhere? | `used-at-cited-line` | A line that names it, and is not its own definition. |
| Does anything tell a person, a log or the caller about this failure? | `tells-someone-at-cited-line` | A log, print, reply, raise, send or similar. |
| Is this a lock or a queue? | `yes-a-lock-or-queue` | A line that makes one. Not the line the claim is on. |
| What kind of class is this? | `project-class`, `library-class` or `builtin-class` | A class definition or an import. |
| Can this call raise the error the handler takes? | `yes-can-raise` | A `raise` or `throw`, or an error constructor. |
| Which function does this call run? | one of the names offered | A line that names the one you chose. |
| Do these places mean the same thing? | `same-meaning` or `different-meaning` | Cannot be checked. It stays cited only. |

The negative answers (`no`, `not-caught`, `not-called`, `not-used`, `tells-no-one`, `no-not-one`, `no-cannot`, `none-of-these`, `different-meaning`) cannot be checked against one line. The tool stores them as your opinion and moves nothing.

## What the tool says back

`review check` prints a tally, for example `{"checked":1,"opinion":1,"no-answer":1,"cited-only":1,"refused":1}`, and writes each result to `map/review-checked.json`.

| Status | Means |
|---|---|
| `checked` | The line exists, holds your quote, and shows what the rule for that question accepts. |
| `cited-only` | The line exists and holds your quote. It does not show what your answer says. |
| `opinion` | A negative answer. Kept, not checked. |
| `no-answer` | You said `cannot-tell`. |
| `refused` | The answer broke a rule. The result says which: `schema`, `no-such-item`, `pinned`, `choice`, `cite`, `line-exists` or `quote`. |

`review view` prints the claim list with your checked answers attached to the claims they touched. A claim's `conf` and `reason` are never rewritten. `--without-agent` prints the claims untouched.

## What an answer can and cannot do

- It can annotate a not-confident claim.
- It cannot add or remove a box or a road. It cannot touch a claim the type checker or the control-flow graph decided (the tool calls those pinned). An answer that names one is refused.
- It does not turn "not confident" into "confident". The page still shows the claim dashed. What changes is that the reader can see what you looked at.

## Answer well

- Read the lines. Open the file if the lines stop short of the answer. Never answer from the question text alone.
- Cite the line that shows it, not the line the claim is on.
- Quote the code, not your own words.
- If two readings are possible, say `cannot-tell`.
- Do not answer in bulk. A wrong answer sits next to the claim for the next reader.
- When you report, say how many questions you answered, how many the tool marked `checked`, and how many are only your opinion.
