# Tests

```
npm install
node bin/faultline.mjs setup        # the Python type checker, once; it prints the folder it went to
FAULTLINE_TOOLS=<that folder> npm test    # node --test test/*.test.mjs
```

Run it as `node --test test/*.test.mjs` (a bare `test/` is not a file). With Python 3.10 or newer, the type checker named by `FAULTLINE_TOOLS`, the packages from `npm install` and nothing else set up, only the browser test skips. A test that needs something missing says what, and shows as skipped:

| Needs | Where it is looked for |
| --- | --- |
| Python 3.10 or newer | `python` or `python3` on the path |
| the Python type checker (`ty`) | the folder in `FAULTLINE_TOOLS` (the one `faultline setup` printed); without it those tests skip and say so |
| `typescript`, `web-tree-sitter`, the Lua grammar | `npm install` |
| a headless browser | only for `FAULTLINE_E2E_BROWSER=1 npm test` |

Every test file starts by giving its process a home of its own (`test/lib/sandbox.mjs`): `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `XDG_*` and the temp folders all point into a new folder made in your temp folder, so no test reads or writes your real home folder or your tool cache, and the result does not depend on what is installed there. `FAULTLINE_TOOLS` is the one thing passed through, and only if you set it. Scratch files go in that new folder, which is removed when the test file ends (`FAULTLINE_KEEP_TEST_HOME=1` keeps it, to look at a failure).

## What is here

- `map-*.test.mjs`: the readers, the call resolver and the rules that draw boxes and roads.
- `read-*.test.mjs`: the reading, its journeys and words, and the page data.
- `story-*.test.mjs`: the check of a story against the tool map.
- the other `*.test.mjs` files: the agent flow (extract, model, place, build) and the viewer's page data.
- `viewer.verify.mjs` and `../viewer/layers.verify.mjs`: checks in a headless browser. Run one section at a time: `node test/viewer.verify.mjs --only layout`.
- `lib/`: helpers shared by the tests. `fixtures/`: small invented projects the tests read; nothing in them is real.
