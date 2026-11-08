// Seeded randomness only (CONTRACTS section 12). mulberry32: tiny, fast, same stream on every platform.
export function rng(seed = 1) {
  let a = (Math.floor(seed) >>> 0) || 1;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  next.int = n => Math.floor(next() * n);
  next.pick = arr => arr[Math.floor(next() * arr.length)];
  next.shuffle = arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  next.fork = k => rng((seed * 2654435761 + k * 40503) >>> 0);
  return next;
}
