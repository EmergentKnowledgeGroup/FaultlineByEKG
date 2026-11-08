// Traps for the TS reader + tsc. Run with: node transpiled, truth in the bottom of the file.
import { readFileSync, writeFileSync } from 'fs';

export class BoomError extends Error {}

function fail(msg: string): never {
  throw new BoomError(msg);
}

function storeIt(x: number) {
  writeFileSync('x.txt', String(x));
}

function nextStep(x: number) {
  writeFileSync('y.txt', String(x));
}

// A1 never-returning helper: the arm cannot reach nextStep
export function a1Never(x: number) {
  if (x > 0) {
    storeIt(x);
    fail('stop');
  }
  nextStep(x);
}

// A2 process.exit in the arm
export function a2Exit(x: number) {
  if (x > 0) {
    storeIt(x);
    process.exit(1);
  }
  nextStep(x);
}

// B1 a generator body does not run at the call
function* genRaises() {
  throw new BoomError('gen');
  yield 1;
}

export function b1GeneratorCall() {
  try {
    const it = genRaises();
    return it;
  } catch (e) {
    console.log('b1 handler ran');
    return null;
  }
}

// B2 a closure in the try body is not called there
function plainRaises() {
  throw new BoomError('plain');
}

export function b2ClosureInTry() {
  try {
    const f = () => plainRaises();
    return f;
  } catch (e) {
    console.log('b2 handler ran');
    return null;
  }
}

// B3 callback handed to setTimeout: the throw goes to the event loop
export function b3TimerInTry() {
  try {
    setTimeout(() => plainRaises(), 0);
  } catch (e) {
    console.log('b3 handler ran');
  }
}

// B4 promise .then: rejection, not throw
export function b4ThenInTry(p: Promise<number>) {
  try {
    p.then(() => plainRaises());
  } catch (e) {
    console.log('b4 handler ran');
  }
}

// B5 async function not awaited
async function asyncRaises() {
  throw new BoomError('async');
}

export function b5NotAwaited() {
  try {
    asyncRaises();
  } catch (e) {
    console.log('b5 handler ran');
  }
}

// B6 return without await from an async function
export async function b6ReturnNoAwait() {
  try {
    return asyncRaises();
  } catch (e) {
    console.log('b6 handler ran');
    return 'caught';
  }
}

// B7 array map with a callback: runs synchronously, so caught. A true road
export function b7MapRuns() {
  try {
    return [1].map(() => plainRaises());
  } catch (e) {
    return 'b7 caught';
  }
}

// C1 object literal method: not called here
export function c1ObjectLiteral() {
  const o = {
    go() {
      storeIt(1);
    },
  };
  return o;
}

// C2 class expression method
export function c2ClassExpression() {
  return class {
    go() {
      storeIt(2);
    }
  };
}

// C3 getter: reading the property runs it
class WithGetter {
  get value() {
    storeIt(3);
    return 3;
  }
}

export function c3Getter() {
  return new WithGetter().value;
}

// D1 hidden callers: returned values, so an (entry) claim can be made
export function d1Hidden() {
  return 1;
}
function d2ByElementAccess() {
  return 2;
}
function d3ByCall() {
  return 3;
}
function d4Tagged(strings: TemplateStringsArray) {
  return strings.length;
}
class Dyn {
  d5ByString() {
    return 5;
  }
  d6ByReflect() {
    return 6;
  }
  d7ByProxy() {
    return 7;
  }
}
const table: Record<string, () => number> = { d2ByElementAccess };

export function run() {
  const a = table['d2ByElementAccess']();
  const b = d3ByCall.call(null);
  const c = d4Tagged`x`;
  const d = new Dyn();
  const name = 'd5' + 'ByString';
  const e = (d as any)[name]();
  const f = Reflect.get(d, 'd6ByReflect').call(d);
  return [a, b, c, e, f];
}

// E1 a wait that isn't awaited
function delay(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export async function e1NotAwaited() {
  Promise.all([delay(1)]);
  return 1;
}

// E2 Promise.race is not awaited
export function e2RaceNoAwait() {
  return Promise.race([delay(1)]);
}

// case 3: readFileSync only reads
export function e3Read(p: string) {
  return readFileSync(p, 'utf8');
}

// E4 sync fs under a flag that says read-only
export function e4Dynamic(p: string, flag: boolean) {
  const fsFn = flag ? writeFileSync : (a: string, b: string) => undefined;
  fsFn(p, 'x');
}

// F1 optional chain call: may not run
export function f1Optional(o?: { go(): void }) {
  o?.go();
  nextStep(1);
}

// F2 switch fall through, labelled break, do-while
export function f2Switch(x: number) {
  outer: for (const y of [1, 2]) {
    switch (x) {
      case 1:
        storeIt(y);
      case 2:
        nextStep(y);
        break outer;
      default:
        continue outer;
    }
  }
  return x;
}

// F3 finally with return overrides a throw
export function f3FinallyReturn() {
  try {
    throw new BoomError('x');
  } finally {
    return 'ate it';
  }
}

// case 1: a same-named class in another scope
export function g1LocalClass() {
  class BoomError extends Error {}
  try {
    plainRaises();
  } catch (e) {
    if (e instanceof BoomError) {
      return 'local';
    }
    throw e;
  }
}
