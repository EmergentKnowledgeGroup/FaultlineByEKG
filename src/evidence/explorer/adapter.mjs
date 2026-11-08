// Client for an explorer adapter: any program that speaks JSON lines on stdin/stdout (CONTRACTS section 9).
// One request per line {id,op,...}; one reply per line {id,ok:true,result} or {id,ok:false,error}.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export class AdapterError extends Error {}

/**
 * The adapter runs with a scrubbed environment: no proxies or credentials, home and temp inside the run folder, cwd in
 * the run folder. This is hygiene, not a sandbox; the adapter itself must refuse network, children and outside writes
 * (see PROTOCOL.md) and proves it with the selftest op.
 */
export function sandboxEnv(runDir, base = process.env) {
  const keep = ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'];
  const env = {};
  for (const k of keep) if (base[k] != null) env[k] = base[k];
  const tmp = path.join(runDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  Object.assign(env, {
    HOME: runDir, USERPROFILE: runDir, TMP: tmp, TEMP: tmp, TMPDIR: tmp,
    FAULTLINE_RUN_DIR: runDir, FAULTLINE_OFFLINE: '1',
    HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
    PYTHONDONTWRITEBYTECODE: '1', PYTHONHASHSEED: '0', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NODE_OPTIONS: '',
  });
  return env;
}

export class AdapterClient {
  /** @param {{cmd:string,args?:string[],runDir:string,timeoutMs?:number}} o */
  constructor(o) {
    this.o = o;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = '';
    this.exited = null;
    this.calls = 0;
  }

  start() {
    const cwd = path.join(this.o.runDir, 'work');
    fs.mkdirSync(cwd, { recursive: true });
    this.child = spawn(this.o.cmd, this.o.args || [], { cwd, env: sandboxEnv(this.o.runDir), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.child.stderr.on('data', (d) => { this.stderr = (this.stderr + d.toString('utf8')).slice(-4000); });
    this.child.stdin.on('error', () => { /* surfaced through the exit handler */ });
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { this.fail(new AdapterError(`adapter printed a line that is not JSON: ${line.slice(0, 120)}`)); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result ?? {});
      else p.reject(new AdapterError(`adapter refused ${p.op}: ${msg.error ?? 'no reason given'}`));
    });
    this.child.on('error', (e) => this.fail(new AdapterError(`could not start the adapter (${this.o.cmd}): ${e.message}`)));
    this.child.on('exit', (code, sig) => {
      this.exited = { code, sig };
      this.fail(new AdapterError(`adapter exited (${sig || code})${this.stderr ? ': ' + this.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') : ''}`));
    });
    return this;
  }

  fail(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.dead = err;
  }

  call(op, params = {}) {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    this.calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new AdapterError(`adapter did not answer ${op} within ${this.o.timeoutMs || 30000} ms`));
      }, this.o.timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer, op });
      this.child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    });
  }

  /** Kill only the process this client started. */
  kill() { try { if (this.child && this.exited == null) this.child.kill(); } catch { /* already gone */ } }

  async close() {
    if (!this.child) return;
    try { this.child.stdin.end(); } catch { /* */ }
    await new Promise((res) => {
      if (this.exited) return res();
      const t = setTimeout(() => { this.kill(); }, 1500);
      this.child.once('exit', () => { clearTimeout(t); res(); });
    });
  }
}

/** Bytes of a state identity: {bytes:"text"} or {b64:"..."}. */
export function identityBuffer(res) {
  if (res && typeof res.b64 === 'string') return Buffer.from(res.b64, 'base64');
  if (res && typeof res.bytes === 'string') return Buffer.from(res.bytes, 'utf8');
  throw new AdapterError('identity must answer {"bytes":"..."} or {"b64":"..."}');
}

export const CLASSES = ['ok', 'end', 'wait', 'stuck', 'invalid', 'cut'];
export const EXPANDS = new Set(['ok', 'wait']);

export function checkClass(res, what) {
  if (!res || !CLASSES.includes(res.class)) throw new AdapterError(`${what}: class must be one of ${CLASSES.join('|')}, got ${JSON.stringify(res?.class)}`);
  return { cls: res.class, reason: String(res.reason ?? '') };
}
