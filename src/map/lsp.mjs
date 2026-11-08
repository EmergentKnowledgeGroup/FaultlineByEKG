// A minimal Language Server Protocol client over a child process's stdin and stdout (JSON-RPC with Content-Length framing).
//   const L = new Lsp(exe, ['server'], { cwd, env });  L.request(method, params) -> id;  L.notify(method, params);  await L.pump(ms) -> next response | null (timeout) | { closed: true }
// Requests the server makes of the client are answered inside pump(): workspace configuration with empty settings, workspace folders with `L.folders`, anything else with null.
import { spawn } from 'node:child_process';

export class Lsp {
  constructor(exe, args, { cwd, env }) {
    this.p = spawn(exe, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.q = [];
    this.waiter = null;
    this.nextId = 1;
    this.folders = [];
    this.buf = Buffer.alloc(0);
    this.p.stdin.on('error', () => { /* the server went away: pump() reports it as closed */ });
    this.p.stdout.on('data', (c) => { this.buf = Buffer.concat([this.buf, c]); this.drain(); });
    this.p.on('error', () => this.push(null));
    this.p.stdout.on('close', () => this.push(null));
  }

  drain() {
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const m = /content-length:\s*(\d+)/i.exec(this.buf.toString('ascii', 0, end));
      const len = m ? Number(m[1]) : 0;
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.toString('utf8', end + 4, end + 4 + len);
      this.buf = this.buf.subarray(end + 4 + len);
      try { this.push(JSON.parse(body)); } catch { /* a message that is not JSON is skipped */ }
    }
  }

  push(m) {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(m); } else this.q.push(m);
  }

  next(ms) {
    if (this.q.length) return Promise.resolve(this.q.shift());
    if (ms <= 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiter = null; resolve(undefined); }, ms);
      this.waiter = (m) => { clearTimeout(t); resolve(m); };
    });
  }

  send(obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.p.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  request(method, params) {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return id;
  }

  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }

  async pump(ms) {
    const end = Date.now() + ms;
    for (;;) {
      const m = await this.next(end - Date.now());
      if (m === undefined) return null;
      if (m === null) return { closed: true };
      if (m.method && m.id !== undefined) {
        const items = (m.params && m.params.items) || [];
        const result = m.method === 'workspace/configuration' ? items.map(() => ({})) : m.method === 'workspace/workspaceFolders' ? this.folders : null;
        this.send({ jsonrpc: '2.0', id: m.id, result });
        continue;
      }
      if (m.method) continue;
      return m;
    }
  }

  kill() { try { this.p.kill(); } catch { /* already gone */ } }
}
