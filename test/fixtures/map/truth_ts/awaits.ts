import { writeFileSync } from 'fs';

function work(x: number) {
  writeFileSync('w.txt', String(x));
  return x;
}

function nextOne(x: number) {
  writeFileSync('n.txt', String(x));
}

function fail(msg: string): never {
  throw new Error(msg);
}

export async function awaited(xs: number[]) {
  await Promise.all(xs.map((x) => work(x)));
  return 1;
}

export function notAwaited(xs: number[]) {
  Promise.all(xs.map((x) => work(x)));
  return 1;
}

export function armThenFail(x: number) {
  if (x > 0) {
    console.log('stopping');
    fail('stop');
  }
  nextOne(x);
}
