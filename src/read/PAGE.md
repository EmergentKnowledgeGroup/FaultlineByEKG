# The reading page

`faultline map` (`page/run.mjs`) writes the reading (`.faultline/read/`: `reading.json`, `charts.json`, `words.json`, `journeys.txt`), turns it into a Faultline project, places the charts and builds one HTML page, `.faultline/dist/atlas.html`. Same inputs give the same bytes: no clock, no random, no hash in anything the page says.

```
faultline map --source <folder with the code> [--project <dir>] [--no-page]
```

`--no-page` stops after the project is written, before the charts are placed and the page is built.

## What each stage does

1. **read** (`src/map`): the Python, TypeScript, JavaScript and Lua readers, and the type checkers' answers.
2. **map**: the rules draw boxes and roads and make every claim. Writes `map/model.json`, `claims.json`, `calls.json` (every call and how it was resolved), `review-index.json` and `story-index.json` (the exact first and last line of every function).
3. **scan** (`src/extract`): facts, census, graph and signals. The map reads the files the scan counts as source, so every box cites a file the scan lists.
4. **reading** (`src/read`): the system's name and purpose, journeys, the main path, endings and who hears about them, switches, terms, stages, one chart per function worth a picture, and the one record of numbers every total on the page comes from. Where a function's first and last line are known from the code index they are used, not guessed from the text.
5. **project** (`page/project.mjs`): stages from the reading's stages; one flow chart per drawn part, with a card for each called function, a stub for each folded exit and a "continues, call not followed" marker (a step, never an ending); a road from each card to the entry of the function's own chart; loops; terms; who-hears entries; which boxes and roads the tool is not confident in, from the claim register. A box's plain text is cut to the model's limit and its full wording goes in `why`. The system is marked `toolMap`: the ledger gates B1, M1, E1, S1 and S2 have nothing to check on a map nobody wrote, so they are not applied to it.
6. **place** (`page/place.mjs`, `page/repair.mjs`): a layered layout for small charts, Faultline's placer for big ones and for any layered chart with a hard defect or many crossings, run in parallel shards (each chart is placed alone, so the shard count does not change a layout); then the stage overview; then a longer search for any chart that still has a hard defect.
7. **build and inject** (`page/inject.mjs`, `page/pack.mjs`, `page/reader/`): the page is built, then its data is rewritten (a folded chart list, the numbers for failures and questions, the questions as "where it can break", the marks for what the tool is not confident in, the tool-map strip), what the page never reads is trimmed, and the Reader is added. The viewer shows all of this only when the page data says it is a tool map (`meta.toolMap`); an agent-made page looks as it always did.

## The Reader

An overlay on the page with: what the system is (the project's own words, with their source, or a plain statement that none was found); what was read, what was not, what is open; the journeys, each readable as a list and walkable step by step across charts (a step with no chart, a choice the tool could not make, and a break are shown as such); the stages; each function (its chart or its outline, who calls it, which journeys pass through it); a trace between two functions that says where the call path breaks; the failing endings by who hears about them; and the switches with their defaults. Every number on it comes from the reading's one numbers record or is the length of a list it shows.

## Limits the page keeps

- A page stays under 16 MB. The number of boxes drawn on charts has a budget (`HOT_BYTES` in `charts.mjs`) for that reason; functions on a journey are drawn first.
- Every chart's box names are at least 11 px at the default view (the viewer's readable floor), and every saved layout has all hard metrics at 0 (`repair.mjs` ends with the list of charts that do not, which is empty when the goal is met).
- Nothing on the page says "no agent wrote any of it" unless that is true; when an agent wrote words, the page says "Words by <model>".

## Journeys, the main path and the words (what the reading now guarantees)

- **A journey is a run.** Each function visit is planned before it is listed (`plan.mjs`): every branch gets one arm (a drawn decision by the walk, any other branch by `walk.pickArm`), the other arm is dead, an arm that returns or raises stops the run at its last line, an arm that breaks leaves the rest of the loop body, a switch takes one case, the handlers of a try are never part of a run, and a decision whose only drawn road leads to a failing ending is a check the run goes past. Blocks come from the scanner's records when it has them and from the source text when it has not (`structure.mjs`). A call that always raises ends the run of its caller. `test/feasibility.test.mjs` checks every journey of invented code against the control-flow graph of the same code.
- **Every journey finishes.** The run ends at the ending on its own route (a box shared by many routes is unfolded to the site that lies on the route), or the journey says "Stopped here, no ending reached" and why. The short version (`hl` on a step) is about 15 to 25 steps, with helper calls folded into one line that says how many steps are inside; the full list is one click down. No step says "step 3 of 202" and no list ends with "N more steps not shown".
- **One main path, by a stated rule.** Journeys are ordered by the names the README and docs show in code examples (front-door examples first, in the order they give them, then the docs' mentions), then by the work they reach. The main path is the first journey when an example named it, or when it reaches at least `CLEAR_WINNER_RATIO` times what the next does; otherwise the page says "No main path found". The rule is printed on the page.
- **One meaning for each number.** An ending is a place where a function returns or raises; a drawn ending box may stand for several. The totals the page states come from `reading.numbers`; `page/textscan.mjs` scans the text of a built page for a total that disagrees, and for words the page must not use ("proven", "whole map", "Fails with *").
- **Words.** The title is the project's name from its metadata or README heading, else its folder. Each stage has a plain name (the folder or file that holds most of it), its path, and one sentence from a class or file comment, or says there is none. Who hears an HTTP status is the client; "a person" is someone who sees what a handler prints. Terms take their meaning from a class comment, a code comment, a README or docs sentence that says what the thing is, or a sentence that only uses it, and say which.
