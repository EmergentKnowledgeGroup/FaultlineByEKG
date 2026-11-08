// Invented names. Labelled jumps, callbacks and a default export; the tests in map-fixes.test.mjs say what the map may claim about each.
import * as fs from 'fs';

function saveA(): void { fs.writeFileSync('a.txt', '1'); }
function saveB(): void { fs.writeFileSync('b.txt', '1'); }
function saveC(): void { fs.writeFileSync('c.txt', '1'); }

export function leaveBoth(): void {
  outer: for (;;) {
    for (;;) {
      break outer;
    }
  }
  fs.writeFileSync('after.txt', '1');
}

export function sieve(rows: number[][]): void {
  outer: for (const r of rows) {
    for (const c of r) {
      if (c < 0) continue outer;
      if (c === 0) break outer;
      saveA();
    }
    saveB();
  }
  saveC();
}

export function blockLeave(x: number): void {
  blk: {
    if (x) break blk;
    saveA();
  }
  saveB();
}

function again(fn: () => void): void {
  fn();
  fn();
}

export function runTwice(): void {
  again(() => saveA());
}

export function eachOne(items: number[]): void {
  items.forEach(() => saveB());
}
