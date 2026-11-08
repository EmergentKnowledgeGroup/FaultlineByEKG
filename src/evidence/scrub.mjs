// What a walk may put into the overlay, and so into a page or agent file made for sharing.
// A walk from logs, spans or another tool carries the machine it ran on: home folders, absolute paths, user names, emails, host names,
// the text of log messages. None of that belongs in the output unless the person asks for the messages (keepMessages).
//   paths  -> the repo-relative form facts use (the same match the importer maps with), else the base name. Never an absolute path.
//   text   -> absolute paths cut to their base name, a home folder (the person's name in it, spaces included) to <home>, emails and the secret
//             shapes listed below masked, whitespace folded, capped.
//   message -> '' unless keepMessages; with it the text is kept (paths and secrets still cut, emails left alone) and capped.
//
// Secrets it recognises and masks (anything else passes through, so a page made from logs should still be read before it is shared):
//   a value after password, passwd, pwd, secret, token, api key, auth or authorization (name=value, name: value, "name":"value"); Bearer and Basic
//   credentials; sk- keys; GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_); AWS access key ids (AKIA, ASIA); Slack tokens (xox..);
//   Google API keys (AIza..); JWTs (eyJ..); private key blocks; credentials inside a URL; webhook URLs; and any run of 32 or more hex digits.
import { normSlashes, parseRef } from './util.mjs';

const END = `[^\\s"'\`<>|*?,;)\\]}]*`;
const FILE_URL = /\bfile:\/+[^\s"'`<>]*/gi;
const UNC = new RegExp(`\\\\\\\\[^\\s\\\\"']+\\\\${END}`, 'g');
// A folder name may hold spaces ("Bob Smith", "My Project", "OneDrive - Acme Corp"). A run of two to four words counts as one folder name when a slash follows it,
// so the words of a path are not left behind when it is cut. Words with a dot or a ~ in them do not join a run (they are file names or the next path: "a.py and ~/b.txt"),
// and the last part of a path, the file, is never given spaces.
const NAME_WORD = `[^\\s\\\\/:*?"<>|,;()\\[\\]{}]+`;
const PLAIN_WORD = `[^\\s\\\\/:*?"<>|,;()\\[\\]{}.~]+`;
const SPACED = `(?:${PLAIN_WORD}(?: ${PLAIN_WORD}){1,3}|${NAME_WORD})`;
const WIN = new RegExp(`\\b[A-Za-z]:[\\\\/](?:${SPACED}[\\\\/])*${END}`, 'g');
const HOME = new RegExp(`(?<![\\w.])~[\\w.-]*[\\\\/]${END}`, 'g');
// /home/bob/x.py, /Users/bob/x, /tmp/run/x: a known system folder with anything under it, or any path of three or more parts. /api/users is a URL path, not a place on a machine.
// A ":" before the slash does not protect it (end:/home/bob/x is a path), a second "/" does (http://host/a/b/c is a URL).
const POSIX = new RegExp(`(?<![\\w.@/~-])(?:/(?:home|Users|root|tmp|var|opt|usr|mnt|srv|etc|private|Volumes|media|workspaces?|app|builds?|runner|github|data|nix)(?:/(?:[\\w@+%=-]+(?: [\\w@+%=-]+){1,3}(?=/)|[\\w.@+%~=-]+))+|(?:/[\\w.@+%~=-]+){3,})/?`, 'g');

// A home folder is C:\Users\<name>, /Users/<name>, /home/<name>, /mnt/c/Users/<name> or a file: URL to one. The name may hold spaces ("Bob Smith"),
// so a name of up to four words is taken when a slash follows it; otherwise only its first word. Everything is replaced by <home>, never by the name.
const HOME_SRC = `(?:file:/*)?(?:[A-Za-z]:[\\\\/](?:Users|users)|/mnt/[A-Za-z]/(?:Users|users)|/[A-Za-z]/Users|/Users|/home)[\\\\/](?:${SPACED}(?=[\\\\/]|$)|${NAME_WORD})`;
const HOME_DIR = new RegExp(`(?<![\\w.~-])${HOME_SRC}`, 'g');
// The same folder written without its leading slash: ../../home/bob/x.py, ./Users/bob/x.py, Users\bob\x.py, home/bob/x.py. It counts only when more path follows
// the name, so "go home/away" and ../home/page.ts are left alone. It may follow "../" or "./" steps; a "/", "\" or word character right before it means it is part
// of some longer path (src/home/page/a.ts), which is not touched here.
const REL_HOME = new RegExp(`(?:(?<![\\w.~@-])(?:\\.{1,2}[\\\\/])+|(?<![\\w.~/\\\\@-]))(?:Users|users|home)[\\\\/]${SPACED}(?=[\\\\/][^\\s\\\\/])`, 'g');
// A network share written as a URL (smb://nas/share/bob/x.py) names a machine and a folder on it, like a UNC path. A web URL is not one.
const SHARE_URL = new RegExp(`\\b(?:smb|cifs|nfs|afp)://${END}`, 'gi');
// A share written with forward slashes (//nas/share/bob/x.py): a host name with no dot, then at least two more parts. A web address has a dot in its host, or a scheme before it.
const SLASH_SHARE = new RegExp(`(?<![\\w:/.@~-])//[\\w-]+(?:/[\\w.@+%~=$-]+){2,}/?`, 'g');
// A home folder named only by how far it sits up the tree (../../home/bob). Two or more steps up, so ../home/page, a folder of the project, is left alone.
const REL_HOME_BARE = new RegExp(`(?<![\\w.~@-])(?:\\.\\.[\\\\/]){2,}(?:Users|users|home)[\\\\/]${NAME_WORD}(?![\\w\\\\/.-])`, 'g');
// A git remote in the short ssh form (git@host:owner/repo.git) names the account that owns the repository. Only the repository name is kept.
const SSH_REMOTE = /\b[\w.-]+@[\w-]+(?:\.[\w-]+)+:(?:[\w.~-]+\/)+([\w.-]+)/g;
const HOME_ONLY = new RegExp(`^${HOME_SRC}[\\\\/]*$`);
const HOME_REF = new RegExp(`<home>(?:[\\\\/](?:${SPACED}[\\\\/])*${END})?`, 'g');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const WEBHOOK = /\bhttps?:\/\/[^\s"'`<>]*(?:hooks\.slack\.com|discord(?:app)?\.com\/api\/webhooks|outlook\.office\.com\/webhook|\/webhooks?\/)[^\s"'`<>]*/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{6,}/gi;
const KEY_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, /\b[sp]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const SECRET = /\b([\w.-]{0,40}(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|auth|authorization|bearer)["']?\s*[=:]\s*["']?)(?:(?:Bearer|Basic|Token)\s+)?[^\s"',;&]+/gi;
const HEX = /\b[0-9a-f]{32,}\b/gi;

/** The last part of a path, with any trailing :line kept. */
export function baseName(p) {
  const parts = normSlashes(p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** True for a path that names a place on one machine: a drive, a UNC share, a leading slash, ~ or a file: URL. */
export const isAbsolute = (p) => { const s = normSlashes(p); return /^[A-Za-z]:\//.test(s) || s.startsWith('/') || s.startsWith('~') || /^file:/i.test(s); };

/** Free text -> text with no machine path, email or secret in it. */
export function scrubText(s, { cap = 160, emails = true } = {}) {
  let t = String(s ?? '');
  t = t.replace(HOME_DIR, '<home>').replace(REL_HOME, '<home>').replace(REL_HOME_BARE, '<home>').replace(HOME_REF, (m) => baseName(m));
  t = t.replace(FILE_URL, (m) => baseName(m)).replace(SHARE_URL, (m) => baseName(m)).replace(SLASH_SHARE, (m) => baseName(m)).replace(UNC, (m) => baseName(m))
    .replace(WIN, (m) => baseName(m)).replace(HOME, (m) => baseName(m)).replace(POSIX, (m) => baseName(m)).replace(SSH_REMOTE, '$1');
  t = t.replace(WEBHOOK, '<webhook>').replace(URL_CREDS, '$1<creds>@').replace(BEARER, '$1 <secret>');
  for (const re of KEY_SHAPES) t = t.replace(re, '<secret>');
  t = t.replace(SECRET, '$1<secret>').replace(HEX, '<token>');
  if (emails) t = t.replace(EMAIL, '<email>');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
}

/** What an absolute path becomes when it is not a file of the project: its base name, or <home> when it is a home folder itself. */
function cutPath(s) {
  if (HOME_ONLY.test(s) || /^~[^/]*$/.test(s)) return '<home>';
  return baseName(s) || '<path>';
}

/** Scrubbers bound to one project: `resolve` is the path resolver the importer maps with, `fns` the function ids in the facts. */
export function makeScrub({ resolve, fns = {} }, { keepMessages = false } = {}) {
  const path = (p) => {
    if (p == null) return p;
    const s = normSlashes(p);
    const hit = resolve ? resolve(s) : null;
    if (hit) return hit;
    if (isAbsolute(s)) return cutPath(s);
    const rel = s.replace(/^(?:\.\.\/)+/, '');
    if (/^(?:Users|home)\//i.test(rel)) return cutPath('/' + rel);          // a relative path that starts at a home folder is one
    return scrubText(rel, { cap: 200 });
  };
  const ref = (r) => {
    if (typeof r !== 'string') return scrubText(String(r ?? ''), { cap: 200 });
    const p = parseRef(r);
    return p ? `${path(p.file)}:${p.line}` : path(r);
  };
  const sym = (id) => {
    if (typeof id !== 'string') return scrubText(String(id ?? ''), { cap: 200 });
    if (fns[id]) return id;
    const i = id.indexOf('::');
    if (i > 0) return `${path(id.slice(0, i))}::${scrubText(id.slice(i + 2), { cap: 200 })}`;
    return isAbsolute(id) ? path(id) : scrubText(id, { cap: 200 });                // a bare absolute path in a symbol place is a path
  };
  const text = (s, o) => scrubText(s, { cap: 200, ...o });
  const message = (s) => (keepMessages ? scrubText(s, { cap: 160, emails: false }) : '');
  return { path, ref, sym, text, message, keepMessages };
}

const PLAIN = /^[\w.:@+-]{1,128}$/;                 // a pin, a hash: kept as it is. Anything else in that place is text and is cleaned.

/**
 * A parsed walk ({header, label, outcomes}) as `walk add` stores it: every path made repo-relative (or cut), every email, secret and home
 * folder masked, the text of reasons kept (so a person can still read what the run said) and not shortened more than needed.
 * `sc` is a makeScrub() for the project. `witness` maps a witness path that is on this machine to the form the stored file may hold.
 * Hashes keep their values (they are the point of the file); their keys are function ids or paths and are cleaned like any other.
 */
export function cleanWalk(w, sc, { witness = (p) => p } = {}) {
  const long = (s) => sc.text(s, { cap: 4000 });
  const deep = (v) => (typeof v === 'string' ? long(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
  const keyed = (obj, f) => (obj && typeof obj === 'object' ? Object.fromEntries(Object.entries(obj).map(([k, x]) => [f(k), x])) : obj);
  const h = w.header || {}, l = w.label || { label: 'NONE', controls_passed: false, explored: [], unexplored: [] };      // a walk with no label line is NONE, as validateWalk reads it
  const header = { ...h, tool: sc.text(h.tool, { cap: 60 }) };
  if (typeof h.pin === 'string' && !PLAIN.test(h.pin)) header.pin = long(h.pin);
  for (const k of Object.keys(h)) if (!['walk', 'tool', 'kind', 'pin', 'hashes', 'fileHashes'].includes(k)) header[k] = deep(h[k]);
  if (h.hashes) header.hashes = keyed(h.hashes, sc.sym);
  if (h.fileHashes) header.fileHashes = keyed(h.fileHashes, sc.path);
  const label = { ...l };
  if (Array.isArray(l.explored)) label.explored = l.explored.map((e) => (typeof e === 'string' ? sc.sym(e) : deep(e)));
  if (Array.isArray(l.notReached)) label.notReached = l.notReached.map((e) => (typeof e === 'string' ? sc.sym(e) : deep(e)));
  if (Array.isArray(l.unexplored)) label.unexplored = l.unexplored.map((u) => (u && typeof u === 'object' ? { ...deep(u), ...(u.at != null ? { at: sc.sym(String(u.at)) } : {}) } : typeof u === 'string' ? sc.sym(u) : u));
  for (const k of Object.keys(l)) if (!['label', 'controls_passed', 'explored', 'unexplored', 'notReached'].includes(k)) label[k] = deep(l[k]);
  const outcomes = (w.outcomes || []).map((o) => {
    const r = { ...o };
    const m = typeof o.outcome === 'string' ? /^(end|stuck):(.+)$/.exec(o.outcome) : null;
    if (m) r.outcome = `${m[1]}:${sc.ref(m[2])}`;
    if (typeof o.reason === 'string') r.reason = long(o.reason);
    if (typeof o.witness === 'string') r.witness = witness(o.witness);
    if (Array.isArray(o.steps)) r.steps = o.steps.map((s) => {
      if (!s || typeof s !== 'object') return s;
      const c = deep(s);
      if (s.ref != null) c.ref = sc.ref(s.ref);
      if (s.sym != null) c.sym = sc.sym(s.sym);
      return c;
    });
    for (const k of Object.keys(o)) if (!['outcome', 'strength', 'reason', 'witness', 'count', 'steps'].includes(k) && !k.startsWith('_')) r[k] = deep(o[k]);
    return r;
  });
  return { header, label, outcomes };
}
