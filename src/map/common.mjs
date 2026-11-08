// What a call DOES, decided from the callee text alone (the dotted name as written). The answers are candidates: effects.mjs
// confirms or drops them once the definition the call lands on is known. Every table row that fires is plain data in this file.
import { PYWS } from './pyrt.mjs';

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

export const LOG_METHODS = set('debug info warning warn error exception critical fatal log');
const LOG_RECV = /(^|\.)(_?logger|_?log|logging|_?LOG(GER)?|console|warnings|diag\w*)$/i;
export const PRINT_CALLS = set(`print sys.stderr.write sys.stdout.write click.echo typer.echo parser.error parser.exit traceback.print_exc console.log
  console.error console.warn alert window.alert process.stderr.write process.stdout.write messagebox.showerror messagebox.showwarning
  messagebox.showinfo showError showSystemNotice`);
const DOTTED_PRINT = [...PRINT_CALLS].filter((p) => p.includes('.')).map((p) => '.' + p);
const RESPOND_RE = new RegExp('(^|\\.)(send_response|send_error|send_header|end_headers|wfile\\.write|_?send_json|_json|' +
  '_respond\\w*|jsonify|make_response|JSONResponse|Response|HTTPResponse|reply|' +
  'res\\.(send|json|status|end)|response\\.(send|json|status|end)|write_json|_send\\w*)$');
const EMIT_RE = new RegExp('(^|\\.)(emit|publish|notify|fire|trigger|broadcast|put|put_nowait|dispatch_event|' +
  'record_event|record_diagnostic|record|add_event|set_event|dispatchEvent|postMessage|' +
  'diagnostic\\w*|report_\\w+|queue_event|enqueue)$');
// candidates only: effects.mjs decides from the resolved definition. `setTimeout` from the language's own library schedules a callback, it does not
// wait; `setTimeout` from node:timers/promises does. `delay` is whatever the project or a package defines.
export const SLEEP_CALLS = set('time.sleep sleep asyncio.sleep trio.sleep anyio.sleep setTimeout delay gevent.sleep time.sleep_ms');
const WAIT_METHODS = set(`wait acquire result communicate recv accept serve_forever select wait_for wait_closed get_nowait_blocking recvfrom readline
  readexactly read_until poll_wait start_blocking run_forever run_until_complete waitFor wait_for_completion join_thread`);
const WAIT_CALLS = set(`input getpass.getpass select.select webview.start threading.Event.wait os.wait os.waitpid signal.pause asyncio.wait asyncio.gather
  asyncio.wait_for asyncio.run Promise.all Promise.race Promise.allSettled readline.question prompt confirm`);
const QUEUEISH = /(queue|_q|inbox|outbox|mailbox|channel|stream|pipe|conn|sock|event|cond|lock|sem|future|thread|proc|worker|task|barrier|latch|pool)s?$/i;
const MACHINE_WAITERS = set('wait acquire serve_forever communicate recv accept result run_forever run_until_complete');
const STORE_METHODS = set(`put_item update_item delete_item batch_write_item put_object delete_object upload_blob upload_file upload_fileobj
  setItem removeItem write_text write_bytes unlink rename replace mkdir touch rmdir commit executemany executescript writelines truncate dump save
  hset sadd xadd setex writeFile writeFileSync appendFile appendFileSync rm rmSync unlinkSync mkdirSync renameSync copyFile multi exec lpush rpush
  zadd hmset del incr incrby expire pexpire evalsha insert insert_one update_one delete_one`);
const DELETE_METHODS = set('unlink rmdir remove rmtree rm rmSync unlinkSync del delete_one removeSync delete_item delete_object removeItem');
const STORE_CALLS = set(`os.remove os.unlink os.rename os.replace os.makedirs os.mkdir os.rmdir shutil.copy shutil.copy2 shutil.copyfile shutil.move
  shutil.rmtree json.dump pickle.dump yaml.dump tempfile.mkstemp os.fsync fs.writeFile fs.writeFileSync`);
// `BEGIN` opens a transaction, it writes nothing
export const SQL_WRITE = new RegExp(`^[${PYWS}]*(insert|update|delete|replace|create|drop|alter|upsert)\\b`, 'i');
export const BOUNDARY_ROOTS = {
  network: set(`requests httpx urllib urllib3 aiohttp socket http websocket websockets smtplib ftplib xmlrpc grpc fetch axios ioredis redis pg net dns
    ollama openai anthropic httplib2 telnetlib paho zmq boto3 discord`),
  process: set('subprocess multiprocessing child_process pty psutil os.system os.startfile os.spawnl os.execv webbrowser worker_threads cluster'),
  gui: set('tkinter webview pywebview pystray PyQt5 PySide6 ctypes win32api win32gui'),
  db: set('sqlite3 psycopg2 sqlalchemy pymongo mysql asyncpg'),
};
const EXIT_CALLS = set('sys.exit os._exit exit quit _exit process.exit os.abort parser.exit parser.error');

const lastPart = (f) => (f ? f.slice(f.lastIndexOf('.') + 1) : '');
const OPENLIKE = new Set(['open', 'io.open', 'Path.open']);
const ERRISH = /(err|fail|problem|issue|warn|reject|refus|skip)\w*$/i;
const QUEUE_GET = /(queue|_q|inbox|mailbox)$/i;

/** -> Set of effect labels for one call as written. A pure function of the text. */
export function classifyCall(f, argc = 0, a0 = null, kws = []) {
  const out = new Set();
  if (!f) return out;
  const lp = lastPart(f);
  const recv = f.includes('.') ? f.slice(0, f.lastIndexOf('.')) : '';
  const recvLast = recv ? recv.slice(recv.lastIndexOf('.') + 1) : '';
  if (PRINT_CALLS.has(f) || DOTTED_PRINT.some((p) => f.endsWith(p))) out.add('print');
  if (LOG_METHODS.has(lp) && (LOG_RECV.test(recv) || recv.endsWith('log') || recv.endsWith('logger'))) out.add('log');
  else if (recv === '?' && ['warning', 'exception', 'critical', 'info', 'debug'].includes(lp)) out.add('log');
  if (['append', 'add', 'extend', 'setdefault', 'put'].includes(lp) && ERRISH.test(recvLast)) out.add('record');
  if (SLEEP_CALLS.has(f)) out.add('wait:time');
  else if (WAIT_CALLS.has(f)) out.add(/^(asyncio|Promise|select|os\.|signal)/.test(f) ? 'wait:machine' : 'wait:person');
  else if (WAIT_METHODS.has(lp) && recv && (QUEUEISH.test(recvLast) || MACHINE_WAITERS.has(lp))) out.add('wait:machine');
  else if ((lp === 'join' && recv && argc === 0) || (lp === 'join' && kws.includes('timeout'))) out.add('wait:machine');
  else if (lp === 'get' && recv && QUEUE_GET.test(recvLast) && (kws.includes('block') || kws.includes('timeout') || argc === 0)) out.add('wait:machine');
  if (RESPOND_RE.test(f)) out.add('respond');
  if (EMIT_RE.test(f) && !out.has('log') && !out.has('print')) out.add('emit');
  if (STORE_CALLS.has(f) || STORE_METHODS.has(lp)) {
    out.add('store');
    if (DELETE_METHODS.has(lp) || ['os.remove', 'os.unlink', 'shutil.rmtree', 'os.rmdir'].includes(f)) out.add('delete');
  }
  if (['execute', 'run', 'execute_query', 'execute_sql', 'executemany', 'exec_driver_sql'].includes(lp) && typeof a0 === 'string' && SQL_WRITE.test(a0)) out.add('store');
  if (OPENLIKE.has(f) || lp === 'open') out.add('store?'); // decided later from the mode argument
  if (EXIT_CALLS.has(f)) out.add('exit');
  return out;
}
