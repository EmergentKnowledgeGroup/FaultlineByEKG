// HTTP route arms: a decision that tests the request path against a literal path ("path == '/api/orders'") is the start of a route.
import { squash } from './util.mjs';

const PATH_VAR = '(?:[A-Za-z_$][\\w$]*\\.)*(?:path|pathname|url|uri|route|href)';
const EXACT = new RegExp(`(?:^|[^\\w$.])${PATH_VAR}\\s*(?:===?|!==?)\\s*(["'\`])(\\/[^"'\`]*)\\1`);
const EXACT_REV = new RegExp(`(["'\`])(\\/[^"'\`]*)\\1\\s*(?:===?|!==?)\\s*${PATH_VAR}\\b`);
const PREFIX = new RegExp(`${PATH_VAR}\\s*(?:\\?\\.)?\\.\\s*(?:startswith|startsWith|endswith|endsWith)\\(\\s*(["'\`])(\\/[^"'\`]*)\\1`);
const MEMBER = new RegExp(`${PATH_VAR}\\s+in\\s+[(\\[{]\\s*(["'\`])(\\/[^"'\`]*)\\1`);
const METHOD_IN_NAME = /(?:^|[._])(?:do_)?(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i;
const METHOD_IN_TEST = /\bmethod\s*(?:===?)\s*["'](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)["']/i;

/** The route a test describes: {path, prefix, method} or null. `fnName` is the qualified name of the function holding the test. */
export function routeOfTest(test, fnName) {
  const t = squash(test ?? '');
  if (!t || t.length > 240) return null;
  let m;
  let path = null;
  let prefix = false;
  if ((m = EXACT.exec(t))) path = m[2];
  else if ((m = EXACT_REV.exec(t))) path = m[2];
  else if ((m = PREFIX.exec(t))) {
    path = m[2];
    prefix = true;
  } else if ((m = MEMBER.exec(t))) path = m[2];
  if (!path) return null;
  const mt = METHOD_IN_TEST.exec(t);
  const mn = METHOD_IN_NAME.exec(fnName ?? '');
  const method = (mt?.[1] ?? mn?.[1] ?? '').toUpperCase();
  return { path, prefix, method, label: `${method ? `${method} ` : ''}${path}${prefix ? '...' : ''}` };
}

/** Routes registered by a call: `app.get("/x", handler)`, `router.post('/y', ...)`: {method, path} or null. */
export function routeOfRegistration(name, firstArgText) {
  const m = /^(get|post|put|delete|patch|head|options|all|use|route)$/i.exec(name);
  if (!m) return null;
  const lit = /^(["'`])(\/[^"'`]*)\1$/.exec(squash(firstArgText ?? ''));
  if (!lit) return null;
  const verb = m[1].toUpperCase();
  return { path: lit[2], prefix: false, method: verb === 'USE' || verb === 'ALL' || verb === 'ROUTE' ? '' : verb, label: `${verb === 'USE' || verb === 'ALL' || verb === 'ROUTE' ? '' : `${verb} `}${lit[2]}` };
}

/** Routes named by a decorator: `@app.get("/x")`, `@router.post('/y')`. */
export function routeOfDecorator(text) {
  const m = /\.\s*(get|post|put|delete|patch|route|websocket)\s*\(\s*(["'])(\/[^"']*)\2/i.exec(text ?? '');
  if (!m) return null;
  const verb = m[1].toUpperCase();
  const method = verb === 'ROUTE' || verb === 'WEBSOCKET' ? '' : verb;
  return { path: m[3], prefix: false, method, label: `${method ? `${method} ` : ''}${m[3]}` };
}
