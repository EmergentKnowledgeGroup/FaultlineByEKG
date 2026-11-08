// A mask of source text: strings, comments and regular expressions are replaced by spaces (new lines are kept), so brackets and keywords
// can be counted on the mask while the original text is cut by the same offsets. The mask has the same length as the text.

/** True when a `/` at `i` starts a regular expression rather than dividing: after an operator, an opening bracket, a comma, or a keyword. */
function regexAllowedAfter(text, i) {
  let k = i - 1;
  while (k >= 0 && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n' || text[k] === '\r')) k--;
  if (k < 0) return true;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(text[k])) return true;
  const word = /([A-Za-z_$][\w$]*)$/.exec(text.slice(Math.max(0, k - 12), k + 1));
  return !!word && /^(return|typeof|case|in|of|delete|void|throw|new|yield|await)$/.test(word[1]);
}

/**
 * @param {string} text
 * @param {'py'|'ts'|'lua'|string} lang
 */
export function maskCode(text, lang) {
  const out = text.split('');
  const n = text.length;
  const blank = (x, y) => {
    for (let k = x; k < y; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  if (lang === 'py') maskPython(text, n, blank);
  else if (lang === 'lua') maskLua(text, n, blank);
  else maskCLike(text, n, blank);
  return out.join('');
}

function maskPython(text, n, blank) {
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const q = triple ? c.repeat(3) : c;
      let j = i + q.length;
      while (j < n) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text.startsWith(q, j)) break;
        if (!triple && text[j] === '\n') break;
        j++;
      }
      blank(i + q.length, Math.min(j, n));
      i = Math.min(j + q.length, n);
      continue;
    }
    i++;
  }
}

function maskLua(text, n, blank) {
  let i = 0;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '-' && c2 === '-') {
      const lm = /^--\[(=*)\[/.exec(text.slice(i, i + 12));
      let j;
      if (lm) {
        const close = `]${lm[1]}]`;
        j = text.indexOf(close, i + lm[0].length);
        j = j < 0 ? n : j + close.length;
      } else {
        j = i;
        while (j < n && text[j] !== '\n') j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '[' && (c2 === '[' || c2 === '=')) {
      const lm = /^\[(=*)\[/.exec(text.slice(i, i + 12));
      if (lm) {
        const close = `]${lm[1]}]`;
        let j = text.indexOf(close, i + lm[0].length);
        j = j < 0 ? n : j;
        blank(i + lm[0].length, j);
        i = Math.min(j + close.length, n);
        continue;
      }
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      blank(i + 1, Math.min(j, n));
      i = Math.min(j + 1, n);
      continue;
    }
    i++;
  }
}

/** C-like languages: comments, quotes, regular expression literals, and template literals whose holes are code. */
function maskCLike(text, n, blank) {
  const TICK = '`';
  // scans from `start`; returns where it stopped: the end of the text, or the "}" that closes a template hole when inHole
  const scan = (start, inHole) => {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = text[i];
      const c2 = text[i + 1];
      if (c === '/' && c2 === '/') {
        let j = i;
        while (j < n && text[j] !== '\n') j++;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '/' && c2 === '*') {
        let j = text.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '/' && regexAllowedAfter(text, i)) {
        let j = i + 1;
        let inClass = false;
        let ok = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) {
            ok = true;
            break;
          }
          j++;
        }
        if (ok) {
          blank(i + 1, j);
          i = j + 1;
          continue;
        }
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (text[j] === '\\') {
            j += 2;
            continue;
          }
          if (text[j] === c || text[j] === '\n') break;
          j++;
        }
        blank(i + 1, Math.min(j, n));
        i = Math.min(j + 1, n);
        continue;
      }
      if (c === TICK) {
        let j = i + 1;
        while (j < n) {
          const d = text[j];
          if (d === '\\') {
            blank(j, Math.min(j + 2, n));
            j += 2;
            continue;
          }
          if (d === TICK) break;
          if (d === '$' && text[j + 1] === '{') {
            j = scan(j + 2, true) + 1;
            continue;
          }
          blank(j, j + 1);
          j++;
        }
        i = Math.min(j + 1, n);
        continue;
      }
      if (inHole) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return i;
          depth--;
        }
      }
      i++;
    }
    return n;
  };
  scan(0, false);
}
