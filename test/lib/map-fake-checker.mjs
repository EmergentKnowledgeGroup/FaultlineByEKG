// A stand-in language server for the checker tests: answers `textDocument/definition` from a script in the environment.
//   FAKE_LS_PLAN = JSON { "<line>:<col>": "steady" | "late" | "never" }
//   steady  the same answer every time; late  empty the first time it is asked and a location after; never  a different location every time
import { Buffer } from 'node:buffer';

const plan = JSON.parse(process.env.FAKE_LS_PLAN || '{}');
const seen = {};
let buf = Buffer.alloc(0);
const send = (o) => { const b = Buffer.from(JSON.stringify(o)); process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`), b])); };

function onMessage(m) {
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } });
  } else if (m.method === 'initialized') {
    send({ jsonrpc: '2.0', id: 9000, method: 'workspace/configuration', params: { items: [{}] } });    // a request the client must answer, not ignore
  } else if (m.method === 'textDocument/definition') {
    const key = `${m.params.position.line + 1}:${m.params.position.character}`;
    const n = (seen[key] = (seen[key] || 0) + 1);
    const kind = plan[key] || 'steady';
    const loc = (line) => ({ uri: 'file:///lib/typeshed/stdlib/os/__init__.pyi', range: { start: { line, character: 4 }, end: { line, character: 9 } } });
    const result = kind === 'late' ? (n === 1 ? [] : [loc(1)]) : kind === 'never' ? [loc(n)] : [loc(1)];
    send({ jsonrpc: '2.0', id: m.id, result });
  } else if (m.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: m.id, result: null });
  } else if (m.method === 'exit') {
    process.exit(0);
  }
}

process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/content-length:\s*(\d+)/i.exec(buf.toString('ascii', 0, end))[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.toString('utf8', end + 4, end + 4 + len);
    buf = buf.subarray(end + 4 + len);
    onMessage(JSON.parse(body));
  }
});
