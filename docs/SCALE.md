# Staying fast and readable on large code

Two things can get large: the code a tool map reads, and a map written by hand. They are placed by different programs and have different limits. Numbers below were measured by running the commands on a Windows 10 PC with Node 24.13.0 and Python 3.13, with other programs running. Anything not listed was not measured.

## The tool map (`faultline map`)

`faultline map` runs seven stages in one process tree and prints the seconds each took. The commands and files of each stage are in `CONTRACTS.md` section 14.

| Stage | What takes the time |
|---|---|
| read | the language readers, and the type checker's answers (Python, TypeScript) |
| map | the rules that draw boxes and roads and make the claims |
| scan | facts, census, graph and signals |
| reading | journeys, the main path, endings, words, charts |
| project | writing the page project |
| place | laying out every chart. By far the largest part on a big codebase |
| build | the page, then the Reader |

Measured, first run into an empty project folder:

| | Toy (`examples/toy`) | A public example (BullMQ: TypeScript, Python, JavaScript and Lua) |
|---|---|---|
| Files read, functions | 19, 69 | 390, 1636 |
| Boxes, roads, claims | 119, 151, 431 | 2829, 4107, 10612 |
| Charts placed | 22 | 438 |
| read, map, scan, reading (s) | 3, 0.6, 0.4, 0.1 | 7.6, 1.9, 3.1, 1.7 |
| place, build (s) | 7.5, 0.4 | 71.8, 2.7 |
| Total (s) | 12.1 | 88.8 |
| Run again into the same project (s) | 4.9 | 35.5 |
| Page size | 0.94 MB | 4.92 MB |
| Hard layout defects | none | none |

The time is in the count of charts, not in any one of them. Charts are independent, so with 40 or more of them `place` runs up to four child processes (`min(4, cpus - 1)`, 4 GB of heap each; the overview and the repair pass run alone with 8 GB). A second run into the same project reuses the layouts that are still valid, so it is faster. Same code, same bytes: a first run, a re-run and a copy in another folder gave identical files on the toy.

The text view stays small on a large map: on the public example `brief` answered in 895 tokens, `breaks` in 790 and `status` in 98, against caps of 1200, 800 and 200. A cap is a hard limit, not a target.

### What a chart is

- One chart for each function worth a picture, with at least 2 boxes (`HOT_FLOOR`). A chart holds at most 21 boxes (`LIMIT`); a bigger function is cut into parts. A box shows at most 9 callee cards (`MAX_CALLS`); the rest are one "N more functions" box.
- A function with no chart is read as an outline in the Reader, with who calls it and which journeys pass through it.
- Small charts get a fast layered layout (columns by depth, rows by the order of the parents, no search) and then the router. A chart over 21 boxes, any layered chart with a hard defect, and any with more than 3 crossings go to Faultline's placer (annealing, 4 s by default).
- After placement, every chart that still has a hard defect (an overlap, a line through a box, a label on a label) is placed again with a longer search, 20 s and then 60 s. The run prints the charts that still have one, and the goal is none.

### The page must stay under 16 MB

The charts drawn are chosen by an estimate of the bytes they add to the page (`HOT_BYTES`, about 8.6 MB in `src/read/charts.mjs`): functions on a journey first, then the functions with the most boxes. The limit the finished page is held to is `PAGE_LIMIT`, 15,500,000 bytes (`src/read/page/run.mjs`). When a finished page is over it, the budget is lowered by the excess and the page is made again, up to three more times, with the layouts already placed kept. The code is deterministic, so a given codebase always takes the same steps. The rest of the page (the Reader, the viewer, the page's own data) takes room too: the whole page is 0.94 MB for the toy and 4.92 MB for the public example.

### Running it on a shared machine

`place` is the heavy part. Each shard may grow to 4 GB of heap, and four run at once; memory use was not measured here. On a machine that runs other work, start `faultline map` in the background through whatever limits heavy jobs there, and do not poll it: it prints each stage as it goes, and the page path is on the last line. `--no-page` stops before `place`; on the toy that took under 2 seconds.

## A map written by hand

Large code broke the placer in the hand-written way, not the mapping. Stage charts were fine and the whole map was not. So: **placement search and libavoid are for charts of up to about 120 boxes. Above that, nothing global gets routed. The whole map is composed from charts already placed.**

### Whole map: tiles and streets (`src/place/tiled.mjs`)

Each stage chart part is already a good small picture. Keep every one, untouched, as a **tile**. Draw the routes between tiles with a fast corridor router. No libavoid, no annealing, no clock.

1. **Tiles.** A tile is a stage chart part's saved geometry: nodes, internal edges with their points and label boxes. Routes inside one part keep their points exactly, translated.
2. **Stage blocks.** The parts of one stage go in a grid, reading order left to right, top to bottom. Pick the column count that brings the block closest to 1.6:1 with the least waste. Columns share a width, rows share a height. Tiles keep their internal layout; they are never mirrored or stretched.
3. **Snake.** Blocks go in rows in story order: left to right, then right to left, and so on (`snake.mjs` holds the idea, block sizes here are real pixels). Pick row breaks by a small search over: dead space, aspect outside 1.3 to 2.2, and link length. **Justify** every row to the full canvas width by widening the street between blocks and the gutters inside them, and stretch every halo to its row's height, so the map reads as a clean rectangle of city blocks. A short last row is allowed only if no other break is within 10% cost. The story starts top-left and no stage is ever displaced.
4. **Corridors.** Everything that is free of boxes is a corridor: streets between blocks, gutters between tiles, the free vertical and horizontal lines inside each tile (derive them from the real node rectangles, not from the config), and the outer margin. Intersections are graph vertices.
5. **Route.** For every route between two tiles: try the box's four sides, take a straight stub to the nearest corridor on that side, then shortest path over the corridor graph, then a stub into the target. Cost = length x class weight (street 0.8, gutter 1, margin 1.2, inside a tile 2.5) + 200 per bend + a load term. Run two passes: the second re-routes with the first pass's real load, so overloaded tile interiors empty out. Fixed order (block distance descending, then id).
6. **Size.** Streets and gutters can grow, tile interiors can't. Count the tracks each street and gutter needs, then set its width to tracks x pitch + margins, and recompute coordinates. Paths are held symbolically (a list of corridors), so nothing re-routes. Pitch starts at 7. If the map leaves the aspect bar, or the canvas passes 40,000 px wide, drop it, floor 4.
7. **Tracks.** Give each route its own coordinate in each corridor. Intervals that overlap get different tracks. Order tracks to cut crossings: by which way the route turns at each end, then by where it is going. Inside a tile, a track must avoid internal segments and label boxes already there (floor pitch 3). Stub attach points are spread along the box side, away from existing route ends and corners, with at least 8 px between them.
8. **Output.** The same geometry shape as any chart: `id, width, height, nodes, edges, clusters`. Cross-tile edges carry `cross: true` and hold their condition as `focusLabel: {x, y, w, h}` on the route's longest segment instead of `labelBox`: it shows only when that route is lit. Metrics do not count `focusLabel` as missing or overlapping. Main path roads carry `spine: true`. Clusters are the stage halos, with a reserved title band inside the halo.

Same inputs, same bytes. A chart at or under `TILED_ABOVE` (120 boxes or 220 routes) keeps the classic `placeWhole`. `place whole --tiled` and `--classic` override it. The layout file stays `layout/whole.json`, now `{ "_faultline": {...}, "tiled": { version, seed, pitch } }`. Its geometry depends on the stage parts' geometry, so a re-placed or re-measured part recomputes it, and `loadLayouts` builds it after the stage charts.

### Overview: a capped set of roads (`src/build/charts.mjs`)

An overview that draws every stage pair can't be placed and can't be read. It draws at most `ceil(2.2 x overview boxes)` roads, chosen in this order:

1. Consecutive stages on the main path.
2. Each box's strongest road out and strongest road in, by routes carried.
3. The rest by routes carried, until the cap.

Everything not drawn goes in `chart.notDrawn: [{from, to, count, when}]`. The page says how many, and selecting a stage lists all of its roads. Nothing vanishes silently: the count is in the chart summary too.

### Budgets that hold

`--budget` is a real ceiling. Every router pass checks it, including starts, rerank, polish and final repair, and placement returns its best so far. A capped chart records `capped: true`, the one case where the same seed may not give the same bytes. `place` prints `[n/total] chart ...` before each chart and the seconds after it.

### One slow chart must not hide the rest

- `look <chart>` works from a saved layout, with no page built.
- `build --draft` builds a page even when charts have no layout, and lists them. `build --finished` still refuses.
- `status` says what exists: no page, an out-of-date page, charts not placed. It says FINISHED only when the page is built and current.

Every command loads layouts. Metrics for a chart are stored beside its geometry and reused while the key matches, so `where` and `status` stay fast on a hundred charts.

### What `place` cost on the hand-written toy

Seven charts in 9 s with `place --force`: each stage chart took 0.4 to 0.7 s, the whole map (35 boxes, 47 routes) 2.9 s, hard metrics 0 on every chart. A larger hand-written map was not timed for this text. The time is in the count of charts, not in any one of them; a stage part that takes far longer than the rest is a chart too dense to read anyway, so split it or look at its boxes.
