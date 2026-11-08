// Where a tab sits, the parts that need no browser: a tab keeps clear of the road condition where it is DRAWN (the pill is pulled to its road), and a tab that has no clean place goes where it touches the fewest words.
// (The page is checked in test/viewer.verify.mjs, section pins.)
import './lib/sandbox.mjs';                                   // a home of its own: nothing here touches the real home folder or tool cache
import test from 'node:test';
import assert from 'node:assert/strict';
import { chipLayout, labelShifts, renderSVG } from '../src/engine/render.mjs';

const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const node = (id, handle, x, y, w = 190, h = 60) => ({ id, title: id, kind: 'step', x, y, w, h, lines: [id], handle });
const edge = (id, pts, labelBox, extra = {}) => ({ id, from: 'a', to: 'b', type: 'forward', pts, labelBox, lines: ['label'], ...extra });

test('labelShifts: the pill moves toward its road, by the same amount renderSVG draws it', () => {
  // a vertical road 26 units right of the pill: the pill is drawn 6 units nearer to it
  const g = { width: 800, height: 500, nodes: [node('a', 'alpha', 300, 200), node('b', 'beta', 560, 380)], clusters: [],
    edges: [edge('e1', [[330, 80], [330, 190]], { x: 200, y: 150, w: 104, h: 21 })] };
  const sh = labelShifts(g).get('e1');
  assert.ok(sh && sh.dx > 0 && sh.dx <= 6 && sh.dy === 0, JSON.stringify(sh));
  const svg = renderSVG(g, { handles: false });
  const m = /data-edge-label="e1"[^>]*><rect x="([-\d.]+)"/.exec(svg);
  assert.ok(m, 'the pill is drawn');
  assert.ok(Math.abs(+m[1] - (200 + sh.dx - 3)) < 0.06, 'drawn at ' + m[1] + ' (placed 200, shift ' + sh.dx + ', padding 3)');
  assert.equal(labelShifts(g, false) instanceof Map, true);
});

test('a tab keeps clear of the pill where it is drawn, not where the placer left it', () => {
  // the pill's own place is clear of the tab's first choice (the top-left corner), but it is pulled 6 units toward its road, into it
  const g = { width: 800, height: 500, nodes: [node('a', 'alphaHandle', 300, 200), node('b', 'beta', 560, 380)], clusters: [],
    edges: [edge('e1', [[330, 100], [330, 178]], { x: 196, y: 176, w: 106, h: 21 })] };
  const sh = labelShifts(g).get('e1');
  assert.ok(sh && sh.dx > 0, 'the pill moves right: ' + JSON.stringify(sh));
  const drawn = { x: 196 + sh.dx, y: 176, w: 106, h: 21 };
  const t = chipLayout(g).a;
  assert.ok(t, 'the tab is placed');
  assert.ok(!hit({ x: t.x, y: t.y, w: t.w, h: t.h }, drawn), 'tab ' + JSON.stringify([t.x, t.y, t.w, t.h, t.anchor]) + ' against the drawn pill ' + JSON.stringify(drawn));
});

test('a tab with no clean place sits on a road, not on words', () => {
  // the box is wrapped in roads 7 units apart, so no place along its borders is clean, and a road condition sits at the corner the tab would take first: the tab goes over roads, not over the words
  const roads = [];
  for (let y = 130; y <= 196; y += 7) roads.push(edge('t' + y, [[236, y], [560, y]], null));
  for (let y = 266; y <= 340; y += 7) roads.push(edge('b' + y, [[236, y], [560, y]], null));
  for (let x = 236; x <= 296; x += 7) roads.push(edge('l' + x, [[x, 130], [x, 340]], null));
  for (let x = 494; x <= 554; x += 7) roads.push(edge('r' + x, [[x, 130], [x, 340]], null));
  const g = { width: 800, height: 500, nodes: [node('a', 'alphaHandleOfSomeLength', 300, 200), node('b', 'beta', 600, 400)], clusters: [],
    edges: [...roads, edge('lab', [[250, 60], [250, 120]], { x: 306, y: 186, w: 96, h: 18 })] };
  const t = chipLayout(g).a;
  assert.ok(t, 'the tab is placed');
  const word = { x: 306 - 4, y: 186 - 4, w: 96 + 8, h: 18 + 8 };
  assert.ok(!hit({ x: t.x, y: t.y, w: t.w, h: t.h }, word), 'the tab ' + JSON.stringify([t.x, t.y, t.w, t.h, t.anchor]) + ' is not on the road condition');
  assert.equal(t.clean, false, 'it has no clean place on this chart, and says so');
});
