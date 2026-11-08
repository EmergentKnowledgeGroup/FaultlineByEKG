// A plain-text rendering of journeys, for people and for tests: one line per step, indented by call depth. A step in the short version starts with `|`.
const MARK = { enter: '>', decision: '?', loop: '@', work: '*', wait: '~', end: '#', step: '-', choice: '|', folded: '+', break: '!', note: '.', finish: '=' };

export function journeyText(j) {
  const out = [];
  out.push(`${j.id}  ${j.name}`);
  out.push(`    ${j.trigger.detail} (${j.trigger.where}); ${j.stats.functions} functions in ${j.stats.files} files, ${j.stats.work} places that do work; short version ${j.stats.headline} steps of ${j.steps.length}`);
  for (const s of j.steps) {
    const pad = '  '.repeat(s.depth + 1);
    const m = MARK[s.kind] ?? '-';
    let line;
    if (s.kind === 'enter') line = `${s.fn}  [${s.where}]${s.via && s.via.kind !== 'trigger' ? `  via ${s.via.kind === 'function value' ? `run by ${s.via.by} (${s.via.where})` : `${s.via.kind} at line ${s.via.line} (${s.via.evidence})`}` : ''}${s.stuck ? `  (${s.stuck})` : ''}${s.col ? `  (${s.col} steps inside)` : ''}${s.more ? `  (${s.more} boxes not listed)` : ''}`;
    else if (s.kind === 'choice') line = `calls one of: ${s.options.join(' | ')}${s.more ? ` and ${s.more} more` : ''}  (line ${s.line}; the tool could not tell which)`;
    else if (s.kind === 'folded') line = `${s.fn} (${s.steps} steps not shown)`;
    else if (s.kind === 'break') line = `${s.reason} (line ${s.line})`;
    else if (s.kind === 'note') line = s.text;
    else if (s.kind === 'finish') line = `${s.title}: ${s.plain}`;
    else line = `${s.title}${s.took ? `   [${s.took}]` : ''}${s.final ? '   [the ending]' : ''}  (line ${s.line})`;
    out.push(`${s.hl ? '|' : ' '}${pad}${m} ${line}`);
  }
  return out.join('\n');
}
