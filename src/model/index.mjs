// src/model: the tool that refuses. CONTRACTS section 11 signatures, plus the helpers the rest of the code can use.
export { loadModel, loadModelReport, mergeFragments, readFragments, modelDirOf, emptyModel, SCHEMA } from './load.mjs';
export { validateModel } from './gates.mjs';
export { analyze, groupFindings, declaredEntries, CHECKS } from './analyze.mjs';
export { propose, pickHints } from './propose.mjs';
export { makeReceipts, writeReceipts, writeJson, hashOf, canonical, GATE_ORDER } from './receipts.mjs';
export { checkProject } from './check.mjs';
export { refusal, ModelRefusal, plainWords, hasBannedWord } from './refusal.mjs';
export { LIMITS, KINDS, STATUSES, OUTCOMES, ROUTE_TYPES } from './text.mjs';
export { buildGraph } from './graph.mjs';
