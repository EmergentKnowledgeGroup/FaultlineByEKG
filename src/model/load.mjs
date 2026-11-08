// loadModel: read model/*.json in filename order and merge. Arrays concatenate, objects merge, duplicate ids refuse.
import fs from 'node:fs';
import path from 'node:path';
import { refusal, ModelRefusal } from './refusal.mjs';
import { realInside } from '../story/source.mjs';

export const SCHEMA = 'faultline.model/1';
// array key -> the field that names a row. Terms are named by the word they define.
const ID_FIELD = { stages: 'id', boxes: 'id', routes: 'id', loops: 'id', paths: 'id', charts: 'id', terms: 'term' };
const KIND_NAME = { stages: 'stage', boxes: 'box', routes: 'route', loops: 'loop', paths: 'path', charts: 'chart', terms: 'term' };
const MAPS = { ledger: 'ledger row', modules: 'module entry' };       // object keyed by id; same key twice refuses
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function emptyModel() {
  return { schema: SCHEMA, system: {}, stages: [], boxes: [], routes: [], loops: [], paths: [], charts: [], terms: [], ledger: {}, modules: {} };
}

function mergeSystem(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (isObj(v)) { if (!isObj(into[k])) into[k] = {}; mergeSystem(into[k], v); }
    else if (v !== '' && v != null) into[k] = v;                    // a later fragment fills or overrides; an empty string never wipes
  }
}

// fragments: [{file, data}] already in merge order. Never throws: returns {model, refusals}.
export function mergeFragments(fragments) {
  const model = emptyModel();
  const refusals = [];
  const src = {};                                                     // kind -> id -> file of first definition
  const dups = {};                                                    // kind label -> [{id, a, b}]
  const noteDup = (label, id, a, b) => (dups[label] ||= []).push({ id, a, b });
  const fragRefs = [];
  for (const { file, data } of fragments) {
    if (!isObj(data)) { fragRefs.push(refusal('F1', 'fragment is not a JSON object', file, 'each model file must hold one JSON object with the faultline.model/1 shape')); continue; }
    if (data.schema != null && data.schema !== SCHEMA) { fragRefs.push(refusal('F1', 'fragment has the wrong schema', `${file} says "${data.schema}"`, `set "schema": "${SCHEMA}"`)); continue; }
    for (const [key, val] of Object.entries(data)) {
      if (key === 'schema') continue;
      if (key === 'system') { if (isObj(val)) mergeSystem(model.system, val); continue; }
      if (ID_FIELD[key]) {
        if (!Array.isArray(val)) { fragRefs.push(refusal('F1', `"${key}" is not a list`, file, `make "${key}" an array`)); continue; }
        const idf = ID_FIELD[key], seen = (src[key] ||= new Map());
        val.forEach((row, i) => {
          if (!isObj(row)) { fragRefs.push(refusal('F1', `"${key}" holds a row that is not an object`, `${file} ${key}[${i}]`, 'rows are objects')); return; }
          const id = row[idf] == null ? '' : String(row[idf]);
          const idKey = key === 'terms' ? id.toLowerCase() : id;
          if (id && seen.has(idKey)) noteDup(KIND_NAME[key], id, seen.get(idKey), file);
          else if (id) seen.set(idKey, file);
          model[key].push(row);
        });
        continue;
      }
      if (MAPS[key]) {
        if (!isObj(val)) { fragRefs.push(refusal('F1', `"${key}" is not an object`, file, `make "${key}" an object keyed by id`)); continue; }
        const seen = (src[key] ||= new Map());
        for (const [id, row] of Object.entries(val)) {
          if (id in model[key]) { if (!same(model[key][id], row)) noteDup(MAPS[key], id, seen.get(id), file); continue; }
          model[key][id] = row; seen.set(id, file);
        }
        continue;
      }
      // unknown top-level key: arrays concatenate, objects merge shallowly, anything else later-wins
      if (Array.isArray(val)) model[key] = [...(model[key] || []), ...val];
      else if (isObj(val)) model[key] = { ...(model[key] || {}), ...val };
      else model[key] = val;
    }
  }
  refusals.push(...fragRefs);
  for (const [label, list] of Object.entries(dups)) {
    const f = list[0];
    refusals.push(refusal('G4', `duplicate ${label} id`, `"${f.id}" is defined in ${f.a} and again in ${f.b}`,
      'give each thing one id, once; ids are never reused for a different thing, so rename or delete one', { at: f.id, offenders: list.map((d) => d.id) }));
  }
  Object.defineProperty(model, 'sources', { value: Object.fromEntries(Object.entries(src).map(([k, m]) => [k, Object.fromEntries(m)])), enumerable: false });
  Object.defineProperty(model, 'fragments', { value: fragments.map((f) => f.file), enumerable: false });
  return { model, refusals };
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

export function modelDirOf(projectDir) {
  const a = path.join(projectDir, 'model');
  if (isDir(a)) return a;
  const b = path.join(projectDir, '.faultline', 'model');
  return isDir(b) ? b : a;
}

// " at line 3, column 5": where the parser stopped, as two numbers. Its own message can quote the start of the file, and that text (a linked or foreign file's) must not reach a refusal.
function where(e, text) {
  const m = /(?:in|after) JSON at position (\d+)/.exec(String(e && e.message));
  if (!m) return '';
  const lines = text.slice(0, +m[1]).split('\n');
  return ` at line ${lines.length}, column ${lines[lines.length - 1].length + 1}`;
}

export function readFragments(projectDir) {
  const dir = modelDirOf(projectDir);
  let realDir = null; try { realDir = fs.realpathSync(dir).replace(/\\/g, '/'); } catch { /* no folder: no fragments, said below */ }
  const refusals = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json') && !n.startsWith('.')); } catch { /* handled below */ }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));                // plain code-point order: same on every machine
  if (!names.length) {
    refusals.push(refusal('F1', 'no model fragments found', dir.replace(/\\/g, '/'), 'write model/00-system.json and one fragment per stage, or run faultline propose for a start'));
    return { dir, fragments: [], refusals };
  }
  const fragments = [];
  for (const n of names) {
    let data, text = '';
    try {
      const real = fs.realpathSync(path.join(dir, n)).replace(/\\/g, '/');          // a fragment that is a link to a file outside the model folder is not read: its text must not reach a message
      if (!realInside(realDir, real)) { refusals.push(refusal('F1', 'fragment is a link to a file outside the model folder', n, 'copy the fragment into the model folder, or remove the link')); continue; }
      text = fs.readFileSync(real, 'utf8').replace(/^﻿/, '');
      data = JSON.parse(text);
    } catch (e) { refusals.push(refusal('F1', 'fragment is not valid JSON', `${n}${where(e, text)}`, 'fix the JSON syntax in that file')); continue; }
    fragments.push({ file: n, data });
  }
  return { dir, fragments, refusals };
}

// Non-throwing form: {model, refusals}. The check command uses this so it can print every refusal in one go.
export function loadModelReport(projectDir) {
  const r = readFragments(projectDir);
  const m = mergeFragments(r.fragments);
  return { model: m.model, refusals: [...r.refusals, ...m.refusals] };
}

// Contract form: returns the merged model, or throws ModelRefusal carrying {code,msg,at} records.
export function loadModel(projectDir) {
  const { model, refusals } = loadModelReport(projectDir);
  if (refusals.length) throw new ModelRefusal(refusals);
  return model;
}
