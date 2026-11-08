// Load a story: one model file, or a model folder of fragments merged in file-name order (arrays join, `system` merges).
// The same rules as the model loader: a duplicate id is a refusal, never a quiet "last one wins". A story that is refused gets no verdicts at all.
import fs from 'node:fs';
import path from 'node:path';
import { cmp, jsonWhere } from './canon.mjs';

export const STORY_SCHEMA = 'faultline.model/1';
const ID_FIELD = { stages: 'id', boxes: 'id', routes: 'id', loops: 'id', paths: 'id', charts: 'id' };
const LABEL = { stages: 'stage', boxes: 'box', routes: 'road', loops: 'loop', paths: 'path', charts: 'chart' };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const refuse = (code, msg, at) => ({ code, msg, at: at ?? '' });

function readFragment(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch { return { err: refuse('S-read', 'cannot read the story file', path.basename(file)) }; }
  try { return { data: JSON.parse(text) }; } catch (e) { return { err: refuse('S-json', jsonWhere(e), path.basename(file)) }; }
}

/** Merge parsed fragments [{file, data}] into one story. Returns { story, refusals }. */
export function mergeStory(fragments) {
  const story = { schema: STORY_SCHEMA, system: {}, stages: [], boxes: [], routes: [], loops: [], paths: [], charts: [] };
  const refusals = [];
  const seen = {};
  for (const { file, data } of fragments) {
    if (!isObj(data)) { refusals.push(refuse('S-shape', 'a story file must hold one JSON object', file)); continue; }
    if (data.schema != null && data.schema !== STORY_SCHEMA) { refusals.push(refuse('S-shape', `the schema is "${String(data.schema).slice(0, 40)}", not ${STORY_SCHEMA}`, file)); continue; }
    for (const [key, val] of Object.entries(data)) {
      if (key === 'schema') continue;
      if (key === 'system') { if (isObj(val)) story.system = { ...story.system, ...val }; continue; }
      if (ID_FIELD[key]) {
        if (!Array.isArray(val)) { refusals.push(refuse('S-shape', `"${key}" is not a list`, file)); continue; }
        const m = (seen[key] ??= new Map());
        val.forEach((row, i) => {
          if (!isObj(row)) { refusals.push(refuse('S-shape', `"${key}" holds a row that is not an object`, `${file} ${key}[${i}]`)); return; }
          const id = typeof row[ID_FIELD[key]] === 'string' ? row[ID_FIELD[key]] : '';
          if (!id) refusals.push(refuse('S-id', `a ${LABEL[key]} has no id`, `${file} ${key}[${i}]`));
          else if (m.has(id)) refusals.push(refuse('S-dup', `duplicate ${LABEL[key]} id "${id.slice(0, 80)}": ${m.get(id) === file ? `it is defined twice in ${file}` : `it is defined in ${m.get(id)} and again in ${file}`}`, id));
          else m.set(id, file);
          story[key].push(row);
        });
        continue;
      }
      if (Array.isArray(val)) story[key] = [...(story[key] ?? []), ...val];
      else if (isObj(val)) story[key] = { ...(story[key] ?? {}), ...val };
      else story[key] = val;
    }
  }
  return { story, refusals };
}

/** Load a story from a file, or from a folder (its `.json` files, or its `model/` subfolder). */
export function loadStory(target) {
  let st;
  try { st = fs.statSync(target); } catch { return { story: null, refusals: [refuse('S-read', 'the story path does not exist', path.basename(target))] }; }
  const files = [];
  if (st.isDirectory()) {
    const dir = fs.existsSync(path.join(target, 'model')) && fs.statSync(path.join(target, 'model')).isDirectory() ? path.join(target, 'model') : target;
    for (const n of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.json') && !x.startsWith('.')).sort(cmp)) files.push(path.join(dir, n));
    if (!files.length) return { story: null, refusals: [refuse('S-read', 'no .json story files in the folder', path.basename(dir))] };
  } else files.push(target);
  const frags = [];
  const refusals = [];
  for (const f of files) {
    const r = readFragment(f);
    if (r.err) refusals.push(r.err); else frags.push({ file: path.basename(f), data: r.data });
  }
  const m = mergeStory(frags);
  return { story: m.story, refusals: [...refusals, ...m.refusals] };
}
