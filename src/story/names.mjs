// Where a name written in a story can be found in the code: the cited function, the cited file, or anywhere the tool read.
import { nameTokens } from './words.mjs';

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/g;

export class CodeNames {
  constructor(L, src) { this.L = L; this.src = src; this.tok = new Map(); this._repoText = null; this._repoTok = null; }

  _memo(key, fn) { if (!this.tok.has(key)) this.tok.set(key, fn()); return this.tok.get(key); }

  fnTokens(fid) {
    return this._memo('f:' + fid, () => {
      const f = this.L.fns.get(fid);
      const ls = f ? this.src.lines(fid.split('::')[0]) ?? [] : [];
      return new Set(f ? (ls.slice(f.line - 1, f.end).join('\n').match(IDENT) ?? []).map((w) => w.toLowerCase()) : []);
    });
  }

  fileTokens(p) {
    return this._memo('p:' + p, () => new Set(((this.src.lines(p) ?? []).join('\n').match(IDENT) ?? []).map((w) => w.toLowerCase())));
  }

  repoText() {
    if (this._repoText == null) this._repoText = [...this.L.mods].sort().map((p) => (this.src.lines(p) ?? []).join('\n')).join('\n').toLowerCase();
    return this._repoText;
  }

  repoTokens() {
    if (this._repoTok == null) {
      const s = new Set();
      for (const p of this.L.mods) {
        for (const w of this.fileTokens(p)) s.add(w);
        const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]*$/, '');
        s.add(base.replace(/-\d+$/, '').toLowerCase());
      }
      this._repoTok = s;
    }
    return this._repoTok;
  }

  /** Check the code-looking names in `text` against the code. `skip`: names that are the story's own ids. Returns null when the text names nothing. */
  mentions(text, refs, skip) {
    const toks = [...nameTokens(text)].filter(([t]) => !skip.has(t) && !skip.has(t.split('.').pop()));
    if (!toks.length) return null;
    const fids = new Set(refs.map((r) => r.fn).filter(Boolean));
    const paths = new Set(refs.map((r) => r.path));
    const ft = new Set();
    for (const f of fids) for (const w of this.fnTokens(f)) ft.add(w);
    const pt = new Set();
    for (const p of paths) for (const w of this.fileTokens(p)) pt.add(w);
    const rep = { n: toks.length, fn: 0, file: 0, repo: 0, nowhere: [] };
    for (const [t, k] of toks.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      if (ft.has(k)) rep.fn++;
      else if (pt.has(k)) rep.file++;
      else if (this.repoTokens().has(k) || this.repoText().includes(k)) rep.repo++;   // a name inside a longer one (_lease_until, getOrderCounts) still counts as found
      else rep.nowhere.push(t);
    }
    return rep;
  }
}
