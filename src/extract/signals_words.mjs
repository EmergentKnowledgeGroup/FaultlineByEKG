// Word lists and small text helpers shared by the signal readers and the signal checks. General words only: nothing named for a system.

// Opposing function-name pairs. Each is [stopSide, startSide]: the side that takes something down comes first.
export const FAMILIES = [
  ['pause', 'resume'], ['stop', 'start'], ['close', 'open'], ['disconnect', 'connect'], ['unlock', 'lock'], ['release', 'acquire'],
  ['disable', 'enable'], ['detach', 'attach'], ['unsubscribe', 'subscribe'], ['unregister', 'register'], ['unmount', 'mount'],
  ['end', 'begin'], ['freeze', 'thaw'], ['hold', 'release'], ['sleep', 'wake'],
];

export const wordsOf = (s) => String(s ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ').trim().toLowerCase().split(/\s+/).filter(Boolean);

export const short = (s, n = 80) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 3).trimEnd() + '...'; };

// A constant that stands for a message, command or event kind: CMD_PAUSE, MSG_HELLO, EVENT_DONE, PAUSE_COMMAND ...
export const MSGY = /^(?:MSG|MESSAGE|CMD|COMMAND|EVT|EVENT|OPCODE|ACTION|SIGNAL|REQ|REQUEST|PKT|PACKET|OP)_[A-Z0-9_]+$|^[A-Z0-9_]+_(?:MSG|MESSAGE|CMD|COMMAND|EVENT|OPCODE|ACTION|SIGNAL)$/;
// ...but not a time, size or path: REQUEST_TIMEOUT_SECONDS says how long, not what is sent.
export const NOT_MSG = /(?:SECONDS|MS|MILLIS|TIMEOUT|DEADLINE|LIMIT|MAX|MIN|SIZE|COUNT|DELAY|INTERVAL|FILE|PATH|URL|DIR|ATTEMPTS|RETRIES|TTL)(?:_|$)/;
export const isMsgConst = (name) => MSGY.test(name) && !NOT_MSG.test(name);
// An enum whose members are plain numbers is usually a set of codes that come from outside (exit codes, script results, wire numbers),
// so only one that is named as messages or commands is judged by who sends it.
export const MSG_ENUM_NAME = /message|msg|command|cmd|event|opcode|action|signal|packet|request|verb|instruction/i;

// A function that answers an event or message by its name.
export const HANDLER_NAME = /^(?:_*on|_*handle)(?:[A-Z_0-9]|$)|(?:Handler|Callback|Listener|_handler|_callback|_listener)$/;
export const LIFECYCLE = new Set(['stop', 'close', 'cancel', 'abort', 'shutdown', 'drain']);
// Teardown words: an error ignored while taking something down is usually a choice, so these are marked, not hidden.
export const TEARDOWN = /\b(?:close|stop|dispose|destroy|cleanup|clean|shutdown|disconnect|terminate|kill|abort|cancel|release|remove|unlink|rm|delete|end|quit|unref|teardown|finalize|exit|aclose)\b/;
export const CLEANUP_CALL = TEARDOWN;

// A call whose name says the failure was passed on: logged, emitted, reported, handed to a callback, rejected.
const HANDLING_EXACT = /^(?:console|logger|logging|log|debug|warn|warning|error|info|trace|fatal|emit|callback|cb|done|next|reject|print|exception|exit|abort|kill|publish|dispatch|traceback)$/i;
const HANDLING_PREFIX = /^(?:log|report|record|notify|fail|capture|track|send|handle|raise|emit|sentry|dispatch|publish|print|throw|set_?exception|set_?error)/i;
export const handlingSeg = (seg) => HANDLING_EXACT.test(seg) || HANDLING_PREFIX.test(seg) || /^on[A-Z_]/.test(seg) || /^on_/.test(seg) || /Error$/.test(seg) || /_error$/.test(seg);

// Which side of which family does this function name belong to? -> [{family:'pause/resume', side:'stop'|'start', stem:'Worker'}]
// A name matches when one of its words is a family word; `stem` is the name with that word replaced by "*", so
// pauseWorker / resumeWorker share the stem "*Worker" and pause / resume share "*".
export function familyOf(name) {
  const words = wordsOf(name), out = [];
  words.forEach((w, i) => {
    FAMILIES.forEach(([stop, start]) => {
      const side = w === stop ? 'stop' : w === start ? 'start' : null;
      if (!side) return;
      const stem = words.map((x, j) => (j === i ? '*' : x)).join(' ');
      out.push({ family: `${stop}/${start}`, side, stem, word: w });
    });
  });
  return out;
}
