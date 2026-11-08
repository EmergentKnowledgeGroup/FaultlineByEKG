# Readers and resolvers: the contract

What `src/map/` hands to the rule engine, and what it expects back. Everything here is deterministic: the same sources in the same declared environment give the same bytes.

## The one call

```js
import { readSystem, loadState } from './index.mjs';
const sys = await readSystem(config);   // reads, asks the checkers, returns plain data
const P = loadState(sys);               // the loaded project the rules start from
```

### config

| field | meaning |
|---|---|
| `root` | absolute path of the system to map. Read only: nothing is written under it. |
| `work` | absolute folder for the Python checker's mirror, cache and answers. A relative path is refused. Needed once the checker is installed. |
| `tools` | absolute folder where `faultline setup` put the checker (default `$FAULTLINE_TOOLS`, else the per-user cache: `%LOCALAPPDATA%/faultline/tools` on Windows, `$XDG_CACHE_HOME/faultline/tools` or `~/.cache/faultline/tools` elsewhere). No checker there: `ty` is null and a note says so. |
| `name` | a short name for the checker's mirror and answers file inside `work` (default `system`). |
| `python` | `{ include: [glob], exclude: [glob] }`: the Python files, as globs relative to `root` (`*`, `**`, `?`), plus excluded folders written without a wildcard. Omit for no Python. |
| `typescript` | `{ prefix: 'src', exclude: [path prefix], tsconfig?: rel path, check?: 'auto' \| 'zero' \| 'tsconfig' \| false }`. Omit for no TypeScript or JavaScript. `auto` uses a tsconfig when the project has one. |
| `lua` | `{ prefix: 'src' }`. Omit for no Lua. |
| `interpreter` | the Python that runs the reader and that the checker is told to analyse against. Default `$FAULTLINE_PYTHON`, else the first of `python`, `python3` on `PATH`. Python 3.10 or newer, else a refusal that names the interpreter and its version. |
| `modules` | `{ typescript?: dir, wasm?: dir }`: a folder holding `node_modules/typescript`, and one holding `web-tree-sitter` with `@tree-sitter-grammars/tree-sitter-lua`. Default: normal module resolution. |
| `log` | `(msg) => void`, progress lines. Default silent. |

### readSystem(config) returns

```js
{
  schema: 'fl.read/1', root,
  ir: { py, ts, lua },       // the three reader documents, parsed; null when that language is not mapped or could not be read
  order: { py },             // what the Python document's sorted lists lose: { classes, fns, clsByName, methodsByName } in the order they were found
  ty: { tool, version, env, sites_asked, answers } | null,   // the Python checker's answers; null = it did not run
  tyMeta: { requests, errors, aborted, passes, differed_between_passes, unstable } | null,   // how the run went; never part of any output file
  sourceFiles, sourceDigest, // every file any reader read, and sha256 over the sorted (path, file sha256) pairs
  notes: [{ code, text }],   // why something did not run: `no-checker`, `checker-incomplete`, `no-typescript`, `no-lua-grammar`. The header says them in words.
  timings: { py, ts, lua, ty }  // milliseconds; never part of any output file
}
```

`ir.py` and `ty.answers` are written with `canonJson`; `ir.ts` and `ir.lua` with `JSON.stringify` (their key order is the writer's).

IR shapes (`schema` `fldet.ir/1` for TypeScript and Lua, `fldet.pyir/1` for Python; the strings are the reader documents' own): `files[]` each with `path`, `module`, `lang` (`py` `ts` `lua`), `lines`, `imports`, `classes[]`, `fns[]`; a function holds `id` (`path::qualified name`), `nodes[]`, `edges[]`, `rd`, `entry`, `exit`, `xexit`. TypeScript files also hold `decls`, `names`, `hidden`, `strs`. The Python document holds the same name facts for the whole project under `facts` (`names`, `hidden`, `strs`, `rebound`, `patched`, `newcls`) and `errors` (`[path, why]`).

Every call op a checker can be asked about carries where: Python `nl`/`nc` (line, UTF-16 column of the callee's name token), TypeScript `op.r` (tsc's answer, already folded into function ids).

## loadState(sys) returns the loaded project

What a project holds after all readers ran and the checkers' answers were handed over, before any call is resolved. Maps and Sets keep insertion order; a pair key is `tkey(a, b)` (the strings joined by `\u0000`). Anything the rules iterate "sorted" is sorted by code point (`cmpCp`), never by the default JS sort. A module's `imports` is a plain object here; `classes.mjs` accepts it as a Map too.

| field | type | meaning |
|---|---|---|
| `root` | string | |
| `fns` | `Map<id, fn>` | Python functions in the order they were found, then TypeScript, then Lua |
| `mods` | `Map<path, {name, imports, lang, lines, decls?, includes?}>` | `imports`: `{local: ['mod', module] \| ['name', module, name]}` |
| `modname` | `Map<dotted module, path>` | |
| `classes` | `Map<key, {name, mod, bases, methods: {name: id}, attrs, line, ncol?}>` | |
| `clsByName` | `Map<name, [key]>` | in the order found; the first match wins in several lookups |
| `modfn` | `Map<tkey(path, qualified name), id>` | module-level functions, first one wins |
| `methodsByName` | `Map<name, [id]>` | |
| `names`, `hidden`, `strs`, `newcls` | `Set<string>` | |
| `rebound` | `Set<tkey(path, name)>` | |
| `patched` | `Set<tkey(class name, attribute)>` | |
| `errors` | `[[path, why]]` | files that could not be read fully |
| `lines` | `Map<path, number>` | |
| `resolvers` | `{ py: string \| null, ts: string \| null }` | checker versions, `null` = none ran |
| `env` | `{ py?, ts? }` | the environment blocks that go in the model header |
| `pyAnswers` | `{ 'path:line:col': [def] \| null } \| null` | `null` = no Python checker |
| `rstat` | `{}` | counters the merge fills |
| `srcDigest`, `nSources` | | what the map stands on |

`checkFresh(P)` throws `StaleInput` when the files under `root` are no longer the ones `P` was loaded from. `loadState` throws it when a reader document's own `source_digest` does not match the files on disk.

The merge of the checkers' answers into call ops is `resolvemix.mjs`: `setPythonAnswers(P, ty)`, `indexDefs(P)`, `resolverPass(P, fn, op, lang) -> [status, defs]`, `roadTargets(op)`, and `effectsOf(P, op, imports, status, defs, decls, shadow, fileish, efx)`, which takes the effects table as its last argument: `{ classifyCall, lexicalDefs, decide, adjust, boundaryOf, isPure, SQL_WRITE }` (Sets for kinds; `SQL_WRITE` a regular expression anchored at the start). The class lookups it needs (`resolveClass`, `mro`, `findMethod`, `subclassesDefining`) are in `classes.mjs`.

## What the readers check, and what they refuse

- A relative `root`, `work` or `tools` folder: refused with a message.
- A Python older than 3.10, or none found: refused, naming the interpreter and its version.
- No checker installed (`setup` not run): `ty` is null and a note says so. The rules then make no negative claims about Python and leave effects as `maybe:`, and the header says it.
- The Python checker is asked until its answers stand still: two full passes, then the sites that differ are asked again one at a time until two answers in a row agree. A site that never settles gets no answer (`null`) and is counted in `tyMeta.unstable`; a run that was cut short or left such sites is never written to the cache.
- `setup` fetches the checker's published wheel over HTTPS, compares its sha256 with the pin in `pins.json` before anything is written or unpacked, and unpacks it itself (no pip).
- `typescript` or the Lua grammar missing: that language is not read, `ir.ts` or `ir.lua` is null, a note says so.

## Tests

`npm test` (`node --test test/*.test.mjs` from the top folder) runs them, with the checker installed by `faultline setup`. Where each tool is looked for is in `test/README.md`.

## Not in this contract

Everything after the loaded state: lexical call resolution, effects, flow, boxes, roads, claims.
