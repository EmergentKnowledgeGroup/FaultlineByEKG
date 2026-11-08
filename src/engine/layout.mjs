// Text measuring for the grid layout: word wrapping and box sizes computed from character counts (no font access, so it is
// deterministic and runs anywhere). Glyph widths are the average advance in px of the 15px node font and the 13px edge-label font;
// a chart overrides them with cfg.glyph = { node, edge } (a wider font needs bigger numbers). FONT holds the nominal sizes
// the stylesheet uses, for the "smallest text at fit" metric.
export const NODE_FONT = 15, EDGE_FONT = 13;
export const FONT = Object.freeze({ node: NODE_FONT, edge: EDGE_FONT, cluster: 13, chip: 11.5, badge: 10.5 });
export const GLYPH = Object.freeze({ node: 7.9, edge: 6.9 });
export const CH_NODE = GLYPH.node, CH_EDGE = GLYPH.edge;   // defaults, kept as plain numbers for older callers

export function wrapText(text, maxChars) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// A road condition wraps in even lines, and a number is never left alone: it stays with the word before it ("above 0", "not 1") and its unit stays with it ("within 2 s").
// Same number of lines as the greedy wrap, never wider than its longest line, so the pill the placer reserved still holds it. A text that cannot be split that way keeps its greedy lines.
const CMPW = /^(above|below|over|under|within|than|to|not|of|at|by|after|before|until|past|exceeds?|from|is|are|equals?|outside|inside|beyond|between|and|or|no|only|first|last|top|more|less|fewer|least|most|=|<|>|<=|>=|≤|≥|≠)[,.;:]?$/i;
const NUMW = /^[(\[]?[-+]?\d[\d.,:/%]*[)\]]?[,.;:]?$/, UNITW = /^(s|ms|m|h|d|x|min|mins|sec|secs|kb|mb|gb|%)[,.;:]?$/i;
const WORDW = /^[A-Za-z][A-Za-z'-]*[,.;:]?$/;
export function balanceLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return lines;
  const words = lines.join(' ').split(/\s+/).filter(Boolean);
  // Atoms are runs of words that stay together. Strict: a number stays with the comparison word before it ("above 0", "not 1") or with the word before it when it ends the text; its unit stays with it ("within 2 s").
  // Relaxed (only when strict leaves a lone last word): a number stays with the word that follows it ("to / 40 characters") and lets go of the comparison word before it.
  const atomsOf = (relaxed) => {
    const atoms = [];
    words.forEach((w, i) => {
      const last = atoms[atoms.length - 1], prev = last && last[last.length - 1], next = words[i + 1];
      const lastWord = i === words.length - 1;
      const joinsCmp = NUMW.test(w) && prev && (lastWord || (CMPW.test(prev) && !(relaxed && next && WORDW.test(next))));
      const joinsUnit = prev && NUMW.test(prev) && (UNITW.test(w) || (relaxed && WORDW.test(w)));
      if (last && (joinsCmp || joinsUnit)) last.push(w); else atoms.push([w]);
    });
    return atoms;
  };
  const n = lines.length, M = Math.max(...lines.map(l => l.length));
  const split = (atoms) => {
    const len = atoms.map(a => a.join(' ').length);
    const best = (W) => {                                        // n lines, each at most W wide, the least ragged split: cost is the squared slack of every line; null when it cannot be done
      const N = atoms.length, INF = 1e9, cost = Array.from({ length: n + 1 }, () => Array(N + 1).fill(INF)), from = Array.from({ length: n + 1 }, () => Array(N + 1).fill(-1));
      cost[0][0] = 0;
      for (let k = 1; k <= n; k++) for (let j = k; j <= N; j++) {
        let w = -1;
        for (let i = j - 1; i >= k - 1; i--) {
          w += len[i] + 1; if (w > W) break;
          if (cost[k - 1][i] >= INF) continue;
          const c = cost[k - 1][i] + (W - w) * (W - w) * (k === n ? 1.001 : 1); if (c < cost[k][j]) { cost[k][j] = c; from[k][j] = i; }          // (a tie goes to the split with the longer last line)
        }
      }
      if (cost[n][N] >= INF) return null;
      const out = []; for (let k = n, j = N; k > 0; k--) { const i = from[k][j]; out.unshift(atoms.slice(i, j).map(a => a.join(' ')).join(' ')); j = i; }
      return out;
    };
    const lone = (r) => r.length > 1 && !/\s/.test(r[r.length - 1]) && /\s/.test(r[r.length - 2]);       // a last line of one word after a line of several
    let first = null;
    for (let W = Math.max(...len); W <= M; W++) { const r = best(W); if (!r) continue; if (!first) first = r; if (!lone(r)) return { first, good: r }; }
    return { first, good: null };
  };
  const strict = split(atomsOf(false));
  if (strict.good) return strict.good;
  const relaxed = split(atomsOf(true));
  return relaxed.good || strict.first || lines;
}
// a road condition wrapped for a pill: greedy to maxChars, then evened out
export const wrapLabel = (text, maxChars) => balanceLines(wrapText(text, maxChars));

// resolved glyph widths for a layout config
export const glyphs = c => ({ node: c?.glyph?.node ?? GLYPH.node, edge: c?.glyph?.edge ?? GLYPH.edge });

// node box from wrapped lines. c: { minNodeW, lineH, glyph }
export function nodeSize(lines, c) {
  const g = glyphs(c);
  const w = Math.max(c.minNodeW, Math.ceil(Math.max(...lines.map(l => l.length)) * g.node + 42));
  const h = Math.max(48, lines.length * c.lineH + 28);
  return { w, h };
}

// edge label pill from wrapped lines (an edge without text has no pill: 0 x 0)
export function edgeLabelSize(lines, c) {
  if (!lines.length) return { lw: 0, lh: 0 };
  const g = glyphs(c);
  return { lw: Math.max(...lines.map(l => l.length)) * g.edge + 12, lh: lines.length * 15 + 6 };
}

// A box name in even lines: balanceLines, with one exception. The count line of an ending pill ("Success endings" over "(12)") is a count set beside its name, not part of it, so it stays alone on its line.
export const nameLines = (lines, kind) => (kind === 'end' && Array.isArray(lines) && lines.length > 1 && /^\(\d[\d,.]*\)$/.test(lines[lines.length - 1]) ? lines : balanceLines(lines));
