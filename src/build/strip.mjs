// Comment stripping for the page's own script and styles. The viewer source is commented for the people who work on it; the page is made for
// the people who read a map, so the comments stay in the repository and are left out of atlas.html.
// stripJs: a small scanner that knows strings, template literals (with ${ } inside), regular expression literals and the two comment forms.
// stripCss: knows strings and block comments. Neither one changes anything except comments, and the whitespace a comment alone on its line leaves.
const WORD_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const isWord = (c) => /[A-Za-z0-9_$]/.test(c);

// Drop the blanks before a removed comment, and the line break after it when nothing else is left on the line.
function dropComment(out, src, from, to) {
  const lineBreak = src.slice(from, to).includes('\n');
  let k = out.length;
  while (k > 0 && (out[k - 1] === ' ' || out[k - 1] === '\t')) k--;
  let o = k === out.length ? out : out.slice(0, k);
  const alone = o === '' || o.endsWith('\n');
  let end = to;
  if (alone) { while (end < src.length && (src[end] === ' ' || src[end] === '\t')) end++; if (src[end] === '\r') end++; if (src[end] === '\n') end++; }
  else if (lineBreak) o += '\n';                                  // a block comment that spanned lines kept the line break it hid (a missing one could join two statements)
  else if (end < src.length && isWord(src[end]) && o && isWord(o[o.length - 1])) o += ' ';
  return { out: o, end };
}

export function stripJs(src) {
  let i = 0;
  const n = src.length;
  function scan(stopAtBrace) {
    let out = '', depth = 0, prev = '', prev2 = '', word = '';
    const sig = (c) => { prev2 = prev; prev = c; };
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '/' && d === '/') {
        let e = i; while (e < n && src[e] !== '\n') e++;
        const r = dropComment(out, src, i, e); out = r.out; i = r.end; continue;
      }
      if (c === '/' && d === '*') {
        let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
        const r = dropComment(out, src, i, e); out = r.out; i = r.end; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
        out += src.slice(i, j + 1); i = j + 1; sig('"'); word = ''; continue;
      }
      if (c === '`') {
        out += c; i++;
        while (i < n && src[i] !== '`') {
          if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
          if (src[i] === '$' && src[i + 1] === '{') { out += '${'; i += 2; out += scan(true); if (src[i] === '}') { out += '}'; i++; } continue; }
          out += src[i++];
        }
        out += '`'; i++; sig('"'); word = ''; continue;
      }
      if (c === '/') {                                              // a regular expression or a division
        const division = prev === ')' || prev === ']' || prev === '}' || prev === '"' || prev === '0' || ((prev === 'a') && !WORD_BEFORE_REGEX.has(word)) || ((prev === '+' || prev === '-') && prev2 === prev);
        if (!division) {
          let j = i + 1, cls = false;
          while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
          if (j < n && src[j] === '/') { j++; while (j < n && /[a-z]/i.test(src[j])) j++; out += src.slice(i, j); i = j; sig('"'); word = ''; continue; }
        }
        out += c; i++; sig('/'); word = ''; continue;
      }
      if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && isWord(src[j])) j++; word = src.slice(i, j); out += word; i = j; sig('a'); continue; }
      if (/[0-9]/.test(c)) { let j = i; while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++; out += src.slice(i, j); i = j; sig('0'); word = ''; continue; }
      if (c === '{') depth++;
      if (c === '}') { if (depth === 0 && stopAtBrace) return out; depth--; }
      out += c; i++;
      if (!/\s/.test(c)) { sig(c); word = ''; }
    }
    return out;
  }
  return scan(false);
}

export function stripCss(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2;
      const r = dropComment(out, src, i, e); out = r.out; i = r.end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1); i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
