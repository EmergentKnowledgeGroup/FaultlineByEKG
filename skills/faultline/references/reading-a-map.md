# Reading a map as an agent

The map exists so you do not have to dig. Use it before you open files. Every answer has a token cap, names box ids and ends with a link your person can open at that exact spot. These commands work on the tool map (`faultline map`) and on a map written by hand.

| You want | Run | Costs at most |
|---|---|---|
| To know what the code is | `faultline brief` | 1200 tokens |
| To know where a file, line or box sits, and every road in and out | `faultline where <box \| file:line \| file \| words from a title>` | 400 |
| To know what might be wrong | `faultline breaks [--stage s] [--all] [--silent]` | 800 |
| To know how you get from here to there | `faultline path <a> <b>` (`--shortest` for fewest hops) | 300 |
| To know what a change could affect | `faultline impact <box \| file>` | 500 |
| To know whether the page exists and matches the stored map (not the code) | `faultline status` | 200 |

A cut answer says so and tells you how to get more: `--budget 2400`. `faultline mcp` serves the same six over MCP stdio. On a map written by hand, `where` also takes a function id such as `parcelworks/worker.py::Worker.run`. On a tool map it does not.

## Ids

On a tool map the page and the text view use short box ids such as `f58.0` (a box in function 58) and `d1` for a stage. They come from the code, so they change when the code changes. Take them from `brief` or `where`. The review queue and story files use the map's own long ids from `map/model.json`; wherever one is printed, the short id is printed beside it, and every command takes either. A function id (`path/file.py::Class.method`), a bare function name and `file:line` work too.

## A good session

1. `faultline status`. Does the page exist, and does it match the stored map? It does not say the code is unchanged.
2. `faultline brief` once, at the start. Note the stages, the loops, the endings and the top candidates.
3. `faultline where` on the thing you were asked about.
4. Read the code it names. The map tells you where to look. It does not replace looking.
5. Before you change something: `faultline impact`. Tell your person which endings it can reach.
6. Hand your person the link from the answer. They see the same box on the page with its roads lit.

## What the words mean

- **Drawn:** the tool read the code and drew this. Nothing was run.
- **Candidate:** the shape of the map raises a question. It is not a verdict. Many are fine. On a tool map, a box with no road in, or a function nothing in the folder calls, is often an entry point called from outside.
- **Not confident:** the tool wrote a label or a road but the evidence is thinner than the words. The page draws it dashed with a "?". `faultline review` is how it gets looked into.
- **Seen:** a run or a coverage report touched this. "Seen" does not mean correct.
- **Proved:** a replayable walk or a model check reached this.
- **Stale:** the cited function changed between the map the evidence was loaded against and the latest `map` run. Code edited since that run is not seen.

"Not found in what was checked" is not "no problem". Only an exhaustive walk with passing controls may say "no violation found", and only within its model. Keep that difference when you report.

## Two lists, not one

On a tool map the page's **Where it can break** lists the ranked questions the reading raised. `faultline breaks` lists shape candidates found in the drawn roads (an ending nothing reaches, a box nothing leads to, a loop with no limit shown). They are different lists with different counts. Say which one you quote.

## Keeping it honest

When code changes, the map is out of date. For a tool map, run `faultline map --source <folder>` again; `review` and `story check` refuse a map when a file it read has changed (a file added since is not noticed). For a map written by hand, update the boxes and roads in `model/*.json`, run `faultline check`, and rebuild. Map and code travel together, or the map starts to lie.
