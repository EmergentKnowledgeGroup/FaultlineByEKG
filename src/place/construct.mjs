// Constructive start for a chart: the happy path as a snake, then everything else dropped next to its strongest placed neighbour.
//   snakeStart(A, g, {W, H, rowStep, rand}) -> Int32Array pos (cell index = c + r * W), or null when the shape cannot hold the nodes
// rowStep 1 = path rows touch (branches hang off the ends); 2 = a free row between path rows (branches sit between, the usual look).

export function snakeStart(A, g, { W, H, rowStep = 2, rand, flipCols = false }) {
  const n = A.n, cells = W * H;
  if (cells < n) return null;
  const pos = new Int32Array(n).fill(-1), occ = new Int32Array(cells).fill(-1);
  const put = (i, c, r) => { pos[i] = r * W + c; occ[r * W + c] = i; };
  const spine = A.spine.map(id => A.idx.get(id));
  const rowsNeeded = (Math.ceil(spine.length / W) - 1) * rowStep + 1;
  if (rowsNeeded > H) return null;
  spine.forEach((i, k) => {
    const row = Math.floor(k / W), within = k % W, c = row % 2 === 0 ? within : W - 1 - within;
    put(i, flipCols ? W - 1 - c : c, row * rowStep);
  });
  // weights between nodes (pairs map is keyed by the smaller index first)
  const nb = Array.from({ length: n }, () => []);
  for (const p of A.pairs.values()) { nb[p.a].push([p.b, p.w]); nb[p.b].push([p.a, p.w]); }
  const placed = new Uint8Array(n); for (const i of spine) placed[i] = 1;
  const rest = []; for (let i = 0; i < n; i++) if (!placed[i]) rest.push(i);
  const PY = 0.5;
  const sinkNode = A.ids.map(id => A.roles[id].end && !A.roles[id].source);
  while (rest.length) {
    // next: the unplaced node most tied to what is placed already (ties: more edges, then input order)
    let bi = -1, bs = -1;
    for (let q = 0; q < rest.length; q++) { const i = rest[q]; let s = 0; for (const [j, w] of nb[i]) if (placed[j]) s += w; s += 0.001 * nb[i].length; if (s > bs + 1e-9) { bs = s; bi = q; } }
    const i = rest.splice(bi, 1)[0];
    let best = -1, bc = Infinity;
    const cand = []; for (let cell = 0; cell < cells; cell++) if (occ[cell] < 0) cand.push(cell);
    rand.shuffle(cand);                                           // tie order must not favour the top-left forever
    for (const cell of cand) {
      const c = cell % W, r = (cell / W) | 0; let cost = 0;
      for (const [j, w] of nb[i]) if (placed[j]) {
        const cj = pos[j] % W, rj = (pos[j] / W) | 0, dc = Math.abs(c - cj), dr = Math.abs(r - rj);
        let d = dc + dr * PY * 2; if (dc && dr) d += 0.7;          // diagonal pairs need a bend
        cost += w * d;
        // a straight run through occupied cells is a detour
        if (dc === 0 || dr === 0) { const lo = Math.min(dc ? c : r, dc ? cj : rj), hi = Math.max(dc ? c : r, dc ? cj : rj); for (let t = lo + 1; t < hi; t++) if (occ[dc ? r * W + t : t * W + c] >= 0) cost += 2.5 * w; }
      }
      if (sinkNode[i]) cost += 1.1 * Math.min(c, W - 1 - c, r * 2 * PY, (H - 1 - r) * 2 * PY);
      cost += 0.01 * (r + c);                                      // compact towards the corner when nothing else decides
      if (cost < bc - 1e-9) { bc = cost; best = cell; }
    }
    if (best < 0) return null;
    put(i, best % W, (best / W) | 0); placed[i] = 1;
  }
  return pos;
}

// cell positions -> ascii map rows with fully empty rows and columns removed
export function toMap(A, pos, W, H) {
  const rows = new Set(), cols = new Set();
  for (let i = 0; i < A.n; i++) { rows.add((pos[i] / W) | 0); cols.add(pos[i] % W); }
  const R = [...rows].sort((a, b) => a - b), C = [...cols].sort((a, b) => a - b);
  const grid = R.map(() => C.map(() => '.'));
  for (let i = 0; i < A.n; i++) grid[R.indexOf((pos[i] / W) | 0)][C.indexOf(pos[i] % W)] = A.ids[i];
  return { map: grid.map(r => r.join(' ')), cols: C.length, rows: R.length };
}
