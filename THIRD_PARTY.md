# Third-party software

Faultline is MIT licensed (see `LICENSE`). It runs on the packages below. They are installed by `npm install` and are not copied into this repository.

| Package | Version | Licence | What it is for |
| --- | --- | --- | --- |
| `typescript` | 5.9.3 | Apache-2.0 | Reads TypeScript and JavaScript, and asks the compiler what each call resolves to. The version is pinned: the map's header records it, and the same code gives the same map only with the same compiler. |
| `web-tree-sitter` | 0.27.1 | MIT | Runs the Lua grammar. |
| `@tree-sitter-grammars/tree-sitter-lua` | 0.4.1 | MIT | The Lua grammar (a WebAssembly file; it also ships prebuilt native files that Faultline does not use). Optional: without it Lua files are not read, and `faultline map` says so. |
| `libavoid-js` | 0.5.0-beta.5 | LGPL-2.1-or-later | The connector router that draws the roads. Used as a library, unmodified. |
| `playwright-core` | 1.65.0 | Apache-2.0 | Optional. Takes screenshots for `faultline look` and the viewer checks. It downloads no browser. |

`@tree-sitter-grammars/tree-sitter-lua` brings `node-addon-api` (MIT) and `node-gyp-build` (MIT). The grammar package declares an install script (`node-gyp-build`) that `npm install` runs; it looks for a prebuilt native file or builds one. Faultline does not use the native file.

## Fetched by `faultline setup`

| Tool | Version | Licence | What it is for |
| --- | --- | --- | --- |
| `ty` | 0.0.97 | MIT | Astral's Python type checker. Faultline asks it what each Python call resolves to. It is not an npm package: `faultline setup` downloads the published wheel, checks its sha256 against the pin in `src/map/pins.json` before anything is written, and unpacks the executable into the per-user cache folder (see the README, Languages and setup). |

## Needed on the machine

Python 3.10 or newer, only to read Python files. Faultline's own Python scripts (`src/map/py`, `src/map/routefacts.py`, `src/extract/*.py`) use the standard library only.
