// The tool cache: the pinned Python type checker (ty), fetched as the project's published wheel over HTTPS, checked against the pinned sha256, and unpacked
// by this file (no pip, no Python needed to run it). Everything lands under one folder; the folders the checker would cache into are redirected there too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fwd, requireAbsolute } from './files.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const pins = () => JSON.parse(fs.readFileSync(path.join(HERE, 'pins.json'), 'utf8'));

/** The per-user folder tools are kept in: $FAULTLINE_TOOLS if set, else the user's cache folder.
 *  Windows: %LOCALAPPDATA%/faultline/tools.  Elsewhere: $XDG_CACHE_HOME/faultline/tools, else ~/.cache/faultline/tools. */
export function defaultToolsDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.FAULTLINE_TOOLS) return env.FAULTLINE_TOOLS;
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'faultline', 'tools');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'faultline', 'tools');
}

/** The folder tools are kept in: the one given, else the per-user cache (defaultToolsDir). Always absolute. */
export function toolsBase(given) {
  return requireAbsolute('the tools folder', given || defaultToolsDir());
}

/** An older setup kept the tools in ~/.faultline/tools. If a checker is still there and it is not the folder in use, one line saying so; else null. */
export function oldToolsNote(given) {
  const old = path.join(os.homedir(), '.faultline', 'tools');
  let has = false;
  try { has = fs.readdirSync(old).some((n) => /^ty-/.test(n)); } catch { /* no old folder */ }
  const now = toolsBase(given);
  if (!has || path.resolve(old).toLowerCase() === path.resolve(now).toLowerCase()) return null;
  return `note: tools from an older setup are in ${fwd(old)} and are no longer used. They now live in ${fwd(now)} (run  faultline setup ); the old folder can be deleted.`;
}

/** Which published wheel fits this machine. */
export function platformKey() {
  const arm = ['arm64', 'aarch64'].includes(os.arch());
  if (process.platform === 'win32') return arm ? 'win_arm64' : 'win_amd64';
  if (process.platform === 'darwin') return arm ? 'macos_arm64' : 'macos_x64';
  const musl = fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1');
  return (musl ? 'linux_musl_' : 'linux_') + (arm ? 'arm64' : 'x64');
}

export const toolDir = (base) => fwd(path.join(toolsBase(base), `ty-${pins().version}`));

/** Path of the pinned checker's executable if installed, else null. */
export function tyBinary(base) {
  const exe = path.join(toolDir(base), 'bin', platformKey().startsWith('win') ? 'ty.exe' : 'ty');
  return fs.existsSync(exe) ? fwd(exe) : null;
}

export function sha256File(p) {
  const h = createHash('sha256');
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** The entries of a zip file: [{ name, method, crc, csize, data }]. Stored and deflated entries only; a zip64 archive is refused. */
export function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('zip64 archives are not supported');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataAt = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    out.push({ name, method, crc, data: () => {
      const raw = buf.subarray(dataAt, dataAt + csize);
      const d = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
      if (!d) throw new Error(`${name}: compression method ${method} is not supported`);
      if (zlib.crc32(d) !== crc) throw new Error(`${name}: checksum mismatch`);
      return d;
    } });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** The bytes at `url`, only if their sha256 is `sha`. Nothing is written before the hash has matched. */
export async function fetchChecked(url, sha, label = url) {
  const res = await fetch(url, { headers: { 'user-agent': 'faultline-setup/1' } });
  if (!res.ok) throw new Error(`fetching ${url} failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const got = createHash('sha256').update(data).digest('hex');
  if (got !== sha) throw new Error(`sha256 mismatch for ${label}: got ${got}, pinned ${sha}`);
  return data;
}

/** Fetch the pinned wheel (unless a copy with the pinned hash is already there), check its sha256, unpack the executable. -> the executable's path. */
export async function installTy(base, log = () => {}) {
  const w = pins().wheels[platformKey()];
  if (!w) throw new Error(`no pinned checker for this platform (${platformKey()})`);
  const root = toolsBase(base), dir = toolDir(base), dl = path.join(root, 'wheels'), whl = path.join(dl, w.filename);
  fs.mkdirSync(dl, { recursive: true });
  if (!(fs.existsSync(whl) && sha256File(whl) === w.sha256)) {
    log(`fetching ${w.url}`);
    const res = await fetch(w.url, { headers: { 'user-agent': 'faultline-setup/1' } });
    if (!res.ok) throw new Error(`fetching ${w.url} failed: HTTP ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(data).digest('hex');
    if (got !== w.sha256) throw new Error(`sha256 mismatch for ${w.filename}: got ${got}, pinned ${w.sha256}`);
    fs.writeFileSync(whl + '.part', data);
    fs.renameSync(whl + '.part', whl);
  }
  log(`sha256 ok  ${w.sha256}  ${w.filename}`);
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  for (const z of readZip(fs.readFileSync(whl))) {
    const base_ = path.posix.basename(z.name);
    if (z.name.includes('/scripts/') && (base_ === 'ty' || base_ === 'ty.exe')) {
      const dest = path.join(dir, 'bin', base_);
      fs.writeFileSync(dest, z.data());
      fs.chmodSync(dest, 0o755);
    } else if (z.name.endsWith('LICENSE')) fs.writeFileSync(path.join(dir, 'LICENSE.txt'), z.data());
  }
  const exe = tyBinary(base);
  if (!exe) throw new Error('the wheel did not contain a ty executable');
  return exe;
}

/** The environment to run the checker in so that nothing it caches lands outside our tree: it unpacks its bundled typeshed under the user cache
 *  folder, so every cache variable points at `cacheDir`. */
export function resolverEnv(cacheDir) {
  const redirect = ['LOCALAPPDATA', 'APPDATA', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'TMP', 'TEMP', 'TMPDIR', 'HOME', 'USERPROFILE'];
  const drop = new Set([...redirect, 'VIRTUAL_ENV']);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!drop.has(k.toUpperCase())) env[k] = v;
  for (const k of redirect) env[k] = cacheDir;
  return env;
}

/** What the checker says its version is, e.g. `ty 0.0.97 (58e168c67 2026-11-04)`. */
export function versionOf(exe, cacheDir) {
  return new Promise((resolve, reject) => {
    execFile(exe, ['--version'], { env: resolverEnv(cacheDir), timeout: 60000, windowsHide: true }, (err, stdout, stderr) => (err ? reject(err) : resolve(String(stdout || stderr).trim())));
  });
}
