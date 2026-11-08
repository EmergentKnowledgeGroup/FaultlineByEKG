# Writing a story over the tool map

Write a story only when your person asks. The tool map already shows what the code does. A story says what the code is for, which no program can read: what matters, what success means, why a retry or a wait exists, what a part is called by the people who own it.

You write words. The tool checks where your lines are and never reads your words. `src/story/STORY_PROMPT.md` holds the same rules as a prompt you can hand to another agent.

## The rules

1. Write only from the tool's phrase on a box and the lines it cites. If you cannot tell, write `unsure`. A guess is worse.
2. Never invent a name, a function, a file or a line number. Every name you write is in the tool's phrase or in a cited line.
3. Group boxes into parts. A part has a title of at most 5 words and one plain sentence. Put the parts in the order a reader should read them. Leave out what does not matter.
4. A box you keep has a title of at most 34 characters (a question if the box is a decision) and one sentence of at most 260. Say what the tool's phrase and the lines say, and no more.
5. Never remove, rename or reuse a box id. Every id appears once.
6. Add a road only by copying a `file:line` from the tool's roads (`routes` in `map/model.json`). If none is there, do not add the road.
7. A condition (`when`) belongs only on a road that leaves a decision. Copy the tool's words for that side, or write `else` for the other side.
8. Do not say anything is proven, verified, checked or confirmed. That is not yours to say.

## What you read

`<project>/map/model.json` lists the boxes (`id`, `kind`, the tool's `title` and `plain`, `refs` with path, symbol and line) and the roads (`from`, `to`, `type`, `when`, and the line they come from). `<project>/map/story-index.json` gives the exact first and last line of every function. `faultline brief` and the page give the picture. These ids are long (for example `parcelworks.worker.Worker.run.d3-b2-b0`) and differ from the short ids (`f58.0`) that `brief` and `where` print. A `file:line` names the same place in both.

## Job A: words only

Short. You add a title and one sentence to boxes the tool already drew.

```json
{ "by": "<your name>",
  "words": { "parcelworks.worker.Worker.run.l3": { "title": "Keep working", "plain": "The worker repeats while it has no tick limit or has not reached it." } } }
```

```
faultline story apply --words words.json --source <folder> [--out FILE] [--report FILE]
```

The tool accepts only `title` and `plain`, on boxes that exist. It refuses, one by one: an unknown id, a title over 34 characters, a sentence over 260, an empty value, a control character, any other field, any `boxes` key and every road. It prints the tally, for example `4 fields accepted, 2 refused, 0 not words, 0 roads refused; structure changed: 0`, and the report names each refusal. Your words go beside the tool's own phrase. The tool's phrase is never overwritten, and a recompute check refuses the whole overlay if anything but `words` on a box moved.

The report also lists warnings: a word that vouches ("proven", "verified"), a decision whose title is not a question, a title that reads as an exit on a box that is not an ending, and two boxes with the same title. Fix those.

## Job B: a whole story

Long. You write a map in words, in the model format, and the tool checks every box and road against its own map.

Before you write a box, answer these in your notes. If you cannot answer one, say so in the story:

1. What does the code promise? What counts as success?
2. How does it end? Every ending a person or caller can see, success and failure.
3. Where does it refuse, and who hears about it?
4. What does it wait on, and what wakes it?
5. What repeats, and what limits each repeat?
6. What is switched off by default?
7. What does the owner call its parts? Use those names.

Then write `model/*.json` files (see `references/model.md` for the format) in a folder of your own, for example `story/model/`:

- A box is something you could point at and ask a question about: a decision, a wait, a store, an ending, an outside call, a step that changes something. Every box cites at least one `{ "path", "symbol", "line" }`. The symbol is a function id `path::qualified.name`, copied from `map/story-index.json`.
- A road says the story goes on. A `when` is the condition in at most 28 characters: "Queue empty", never "checks the queue".
- Endings are boxes with an `outcome`: `success`, `failure`, `refusal` or `neutral`. Say who hears about each failure.
- Keep the status honest: `live`, `default-on`, `off` or `test-only`, and name the switch.
- A loop names what limits it. If nothing does, leave `limit` empty. That is a candidate.

```
faultline story check --story story/ --source <folder>        # a file, or a folder of .json files (or its model/ folder)
faultline story page   --source <folder>                      # dist/atlas.story.html: the page plus the story's marks
```

`story check` writes `<project>/story/check.json` and prints a header. For the toy's hand-written map it reads: `47 roads: 5 joined by the tool at the cited line, 8 joined by a route, 7 related in the code, 27 no link found. 35 boxes: 25 in a tool box, 10 real code with no tool box, 0 partly found, 0 not found.` What the words mean:

| Road | Means |
|---|---|
| joined by the tool at this line | The tool has a road between the two cited places at the line you cite. |
| joined by a route | The tool joins them through a short route of calls. |
| related in the code | Joined, but through something the tool is not sure of. |
| no link found | The tool finds no call between them. A queue, a database or an event can be a real link the tool cannot see. |

| Box | Means |
|---|---|
| in a tool box | The tool drew a box where you point. |
| real code, no tool box | There is code there, and the tool drew no box for it. |
| partly found, not found | The cited code is only partly there, or not there. |

The check also compares the kind of box with what the tool sees at the cited lines, and a condition with the side of the test the tool draws, in the few ways a program can compare words. Its flags (`cite-loose`, `refs-apart`, `no-wait-at-cite` and the like) are in `check.json`. Treat every flagged item as a research list: read the code, cite a better line, or drop the item. Nothing you write can raise a verdict, and a road that stands on a road the tool is not sure of is passed on as "related in the code".

Exit codes: 3 when the story is refused whole (an id used twice, bad JSON), 4 when the map cannot be used (missing, or a file it read changed after it was made, but not a file added since; `--allow-stale` lets the check run anyway).

## Five ways this goes wrong

1. **The job shrinks.** "The whole thing" becomes "cite every module". A cited module is not a told story. Cover the endings and the decisions.
2. **You tell the log.** What the code writes down is not what it can do. Tell it from the code: branches, refusals, holds, retries. A straight line is wrong.
3. **You scrub or invent words.** Write plain words and the code's own names, always both. Never invent a name. Keep a term you cannot translate without guessing, and explain it.
4. **You vouch.** The tool says "joined by the tool". You do not say "proven". Your sentences are "words, not checked".
5. **You trust the numbers.** A story can have every road joined and still be wrong about what the code is for. Open the page.

## A page of its own

A whole story can also get a page of its own with the older commands, in a project folder that is not the tool map's: `faultline init --project <dir>`, `extract`, `check`, `place`, `build`, `look --page`. See `references/model.md` for the gates and `references/look-test.md` for how to look at it. A large story split across several agents is in `references/large-systems.md`.

## Handing it over

Say that it is words, not checked. Give the tool's tally from `story check`, what you could not follow, which parts you left out and why, and which flagged items you looked into and which you left.
