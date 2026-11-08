// Shared set-up for the story tests: the invented kiosk system (source, tool map, an honest story) and small builders.
//   Scratch folders go in the system temp folder (TMP / TEMP / TMPDIR move it).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkStory } from '../../src/story/check.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
export const KIOSK = `${HERE}/../fixtures/story/kiosk`;
export const MAP = `${KIOSK}/map`;
export const ROOT = `${KIOSK}/src`;
export const BIN = `${HERE}/../../bin/faultline.mjs`;
export const honest = () => JSON.parse(fs.readFileSync(`${KIOSK}/honest.json`, 'utf8'));

/** A named scratch folder (made if missing, reused between runs). */
export function scratch(name) {
  const base = path.resolve(path.join(os.tmpdir(), 'faultline-story-tests')).replace(/\\/g, '/');
  const dir = `${base}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export const SALES = 'kiosk/sales.py';
export const ref = (file, line, fn) => ({ path: file, symbol: fn ? `${file}::${fn}` : '', line });
export const sref = (line, fn = 'sell_ticket') => ref(SALES, line, fn);

export function box(id, kind, title, refs, extra = {}) {
  return { id, stage: 'sell', kind, title, plain: extra.plain ?? title + '.', status: 'live', handle: '', refs, ...extra };
}
export function road(id, from, to, when, refs, extra = {}) {
  return { id, from, to, type: 'forward', when, why: '', refs, inferred: false, ...extra };
}

/** Run the check on a story object against the kiosk tool map. */
export function run(story, opts = {}) {
  return checkStory(story, { mapDir: opts.map ?? MAP, root: opts.root ?? ROOT, allowStale: opts.allowStale ?? true });
}

/** The honest story plus extra boxes and roads. */
export function withExtra(boxes = [], roads = []) {
  const s = honest();
  s.boxes.push(...boxes);
  s.routes.push(...roads);
  return s;
}

/** A story of only the given boxes and roads (no honest ones beside them). */
export function only(boxes, roads) {
  return { schema: 'faultline.model/1', system: {}, stages: [{ id: 'sell', title: 'Selling' }], boxes, routes: roads, paths: [] };
}
