// The only way the story layer reads source code. Every path an agent writes goes through here first.
//
//   const src = new RootedSource('/abs/root');
//   src.ref('src/a.py')   -> { ok: true, rel } | { ok: false, why }   (lexical test only: nothing is opened)
//   src.lines('src/a.py') -> string[] | null                          (null: not a readable file inside the root)
//   src.line('src/a.py', 7) -> string | null
//
// A path is refused, and its file never opened, when it is not a plain relative path that stays inside the root: absolute paths, drive letters,
// backslashes, `..` that climbs out, control characters. A path that passes the text test is also refused when the file it names is a link that
// leads outside the root. Text of a refused path is never read, so it can never reach an output.
import fs from 'node:fs';
import path from 'node:path';

/** A single source file bigger than this is generated or data, not code the checker needs to look inside. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_PATH_CHARS = 1024;
const CONTROL = /[\u0000-\u001f\u007f]/;
const DRIVE = /^[A-Za-z]:/;

export class RootedSource {
  constructor(root) {
    this.root = path.resolve(root).replace(/\\/g, '/');
    try { this.real = fs.realpathSync(this.root).replace(/\\/g, '/'); } catch { this.real = null; }
    this.cache = new Map();
  }

  /** Lexical test. Returns the clean relative path, or why it was refused. Never touches the disk. */
  ref(rel) {
    if (typeof rel !== 'string' || !rel) return { ok: false, why: 'no path' };
    if (rel.length > MAX_PATH_CHARS) return { ok: false, why: 'path is too long' };
    if (CONTROL.test(rel)) return { ok: false, why: 'path holds control characters' };
    if (rel.includes('\\')) return { ok: false, why: 'path uses a backslash; write it with forward slashes, relative to the root' };
    if (rel.startsWith('/') || DRIVE.test(rel)) return { ok: false, why: 'path is outside the root (absolute)' };
    const clean = path.posix.normalize(rel);
    if (clean === '..' || clean.startsWith('../')) return { ok: false, why: 'path is outside the root' };
    if (clean === '.' || clean.endsWith('/')) return { ok: false, why: 'path names a folder, not a file' };
    return { ok: true, rel: clean };
  }

  /** The lines of a file inside the root (CRLF and CR read as LF), or null. A link that leads outside the root is not read. */
  lines(rel) {
    const r = this.ref(rel);
    if (!r.ok) return null;
    const key = r.rel;
    if (this.cache.has(key)) return this.cache.get(key);
    let out = null;
    try {
      const abs = path.join(this.root, key);
      const real = fs.realpathSync(abs).replace(/\\/g, '/');
      const inside = this.real != null && (real === this.real || real.startsWith(this.real.endsWith('/') ? this.real : this.real + '/'));
      if (inside) {
        const st = fs.statSync(real);
        if (st.isFile() && st.size <= MAX_SOURCE_BYTES) out = fs.readFileSync(real, 'utf8').replace(/\r\n?/g, '\n').split('\n');
      }
    } catch { out = null; }
    this.cache.set(key, out);
    return out;
  }

  /** Why `lines` gave nothing: 'outside', 'missing' or 'unreadable'. Only meant for a path whose text test passed. */
  whyNot(rel) {
    const r = this.ref(rel);
    if (!r.ok) return 'outside';
    try {
      const real = fs.realpathSync(path.join(this.root, r.rel)).replace(/\\/g, '/');
      const inside = this.real != null && (real === this.real || real.startsWith(this.real.endsWith('/') ? this.real : this.real + '/'));
      return inside ? 'unreadable' : 'outside';
    } catch { return 'missing'; }
  }

  line(rel, n) {
    const ls = this.lines(rel);
    return ls == null || !Number.isInteger(n) || n < 1 || n > ls.length ? null : ls[n - 1];
  }
}
