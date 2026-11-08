---
name: faultline
description: Map a codebase into a page for people and a small text view for agents, with every doubt marked. Use when asked to map, chart or explain how a codebase is laid out, where it could stop, loop or fail, or what a change could affect. Also use when a repo has a .faultline folder, when asked to answer Faultline's review questions, or when asked to write a story over a map.
---

# Faultline: the tool makes the map, you answer its questions

Faultline reads code and draws what it does: boxes for what happens, roads for what leads to what. A program does this, with no agent. You do not make the map. You run it, read it, and look into the places where the tool says it is not sure.

| The tool does | You do |
|---|---|
| Reads the code and draws every box and road | Run it: `setup`, then `map` |
| Labels each claim confident or not confident, with a reason | Read the page and the text view. Tell your person what they say |
| Writes a list of questions about the not-confident claims | Answer them from the cited lines, with a quote (`faultline review`) |
| Checks every answer and every story against the code | Write a story only when asked (`faultline story`) |

## Rules for every job

1. **You never draw.** No coordinates, no hand-written SVG or HTML. You never add, remove or rename a box or a road on the tool map. Your answers and your words sit beside the map. They do not change it.
2. **The map is read from the code. Nothing was run.** Say so when you report.
3. **If you cannot tell, say so.** Use `cannot-tell` in a review answer and `unsure` in a story. A guess is worse.
4. **Use these words.** "Candidate", never "bug". "Not drawn", never "does not exist". "No limit shown", never "unbounded". "Joined by the tool" for a road the tool finds. "Words, not checked" for anything you wrote. Never "proven", "verified", "confirmed", "safe", "complete" or "covers the whole system".
5. **Say what was not read.** Every line that starts with `note:` in a run is something the tool could not read. Copy those into your hand-over.
6. **Do not change the source tree.** Everything Faultline writes goes in the `.faultline` folder, or the folder you give with `--project`.
7. **Do not sit in a sleep loop.** A large codebase takes minutes. Start it in the background and look at the result when it ends.

## Job 1: get the map

If `faultline` is not on your path, use `node <install folder>/bin/faultline.mjs` everywhere below.

```
faultline setup                                  # once. Only needed if the code has Python
faultline map --source <folder with the code>    # reads, draws, builds the page
```

- The page is `.faultline/dist/atlas.html`, and the run prints its path. It is one file. Give your person the path.
- The code is only read. Use `--project DIR` to keep the output out of the repo.
- To read only part of the code, make `<project>/config.json` with `{"include": ["src/**"], "exclude": []}` before the run.
- `--no-page` stops before the page is built. Run `map` again without it to finish.
- Running `map` again after the code changed rebuilds the map. The same code gives the same files.
- A repo you cloned may ship its own `.faultline` folder. That is someone else's input, not a map you can trust: run `faultline map` yourself before you read it, review it or build on it.

If a run stops with a message:

| Message | What to do |
|---|---|
| "holds a map written by hand" | Give `--project` a folder of its own. |
| "nothing to read" | Wrong folder. It has no Python, TypeScript, JavaScript or Lua. |
| "Python 3.10 or newer was not found" (a note) | Install Python 3.10 or newer, or name one with `--interpreter`. TypeScript and Lua are still mapped. |
| "the Python type checker (ty) is not installed" (a note) | Run `faultline setup`, then `map` again. Until then more claims are not confident. |
| "web-tree-sitter or the Lua grammar is not installed" (a note) | Lua files were not read. Run `npm install` in the Faultline folder. |

## Job 2: read the map

Use the map before you open files. Each answer is small and ends with a link a person can open.

```
faultline status               # what exists, whether the page and the code still match the map
faultline brief                # the whole picture, about 1200 tokens
faultline where <box | file:line | words from a title>
faultline breaks               # candidates, one question each
faultline path <box> <box>     # a route the roads allow, with conditions
faultline impact <box | file>  # what is downstream
```

Take box ids (such as `f58.0`) from `brief` or `where`; the long ids that `review` and `story` print work as well, and so do a function id (`path/file.py::Class.method`), a bare function name and `file:line`. A `path` answer is a route the roads allow, not a promise that one request takes it. Details and what the words mean: `references/reading-a-map.md`.

On a tool map `status` says what was read, what is open and what to do next, `brief` opens with the same three lines, and `breaks` lists the same ranked questions the page lists, with the same counts. Read `status` first: it also says if the page no longer matches the stored map, and its `code:` line says whether the code still matches the map. If it says the code is BEHIND, run `faultline map` again before you trust any answer; `status` reports that and does not update the map.

## Job 3: work the review queue

The tool lists what it is not sure of as questions. This is where you help.

```
faultline review queue --source <folder you gave to map> --limit 10 --out queue.json
```

Each question has an `item` id, one question, the lines to read, and a closed list of answers. Read the lines. Open the file if you need more. Then write an answers file and check it:

```
{ "answers": [ { "item": "<item id copied exactly>", "choice": "<one of its answers>", "cite": "path/to/file.py:68", "quote": "text from that line" } ] }
```

```
faultline review check --answers answers.json --source <folder>
faultline review view  --source <folder>
```

The tool re-reads your cited line. It marks the answer checked, cited only, opinion, no answer or refused. A negative answer is kept as an opinion and moves nothing. Answer only what the lines show. The full rules and the answer sets are in `references/review.md`.

## Job 4: a story (only when asked)

A story is words about what the code is for, which the tool cannot tell. Write one only when your person asks for it. Read `references/story.md` first, to the end. In short:

- **Words only:** titles and one sentence for boxes the tool already drew. `faultline story apply --words words.json`.
- **A whole story:** a map written in the model format, every box and road citing real lines. `faultline story check --story <file or folder>`.
- Then `faultline story page` adds the result to the page.

The tool gives each road "joined by the tool at this line", "joined by a route", "related in the code" or "no link found", and each box "in a tool box", "real code, no tool box", "partly found" or "not found". It does not read your words. The page marks them "words, not checked".

## Evidence, if someone has it

A run, a test or a coverage report can be added as a walk (`faultline walk add run.walk.jsonl`), and `where` then shows a box as seen. After `walk add`, run `faultline build`: on a tool map it rebuilds the page with the Reader and the walk. It reads no code (unless you pass `--excerpts`); run `faultline map` again to refresh a map whose code changed. See `references/evidence.md`.

## Handing it over

End with these, in this order, in plain words:

1. What you ran, and the path to `dist/atlas.html`.
2. **What the tool did not read.** Every `note:` line, and anything you could not follow.
3. What the tool is not sure of: how many claims, and how many questions you answered. Say which answers the tool marked checked and which are only your opinion.
4. The candidates worth a person's time, each as a question with its link.
5. If you wrote a story: say it is words, not checked, and give the tool's tally from `story check`.

Never write "complete" or "all obligations met" on your own authority. The tool's numbers are the only numbers you may quote.

## Older way, and big stories

Before `faultline map`, a map was written by hand: `init`, `extract`, `propose`, write `model/*.json`, `check`, `place`, `build`. That is now how a full story is written, and it makes a page of its own. It does not make the tool map and must not share its folder.

- `references/model.md`: the model format and the gates.
- `references/large-systems.md`: a large story split across several agents.
- `references/look-test.md`: how to look at a page and what to check.
