/* Faultline by EKG: the front door. Plain JavaScript, no libraries, not minified. Each part is wrapped in its own function and looks for its own element. */

/* ---- src/js/base.js ---- */
/* Shared: the colour mode toggle and the copy buttons.
 * The choice is kept in localStorage inside try/catch: if storage is blocked, the page still follows the system. */
(() => {
  const root = document.documentElement;
  const toggle = document.querySelector('[data-theme-toggle]');
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const current = () => root.getAttribute('data-theme') || (scheme.matches ? 'dark' : 'light');

  function paint() {
    if (!toggle) return;
    const dark = current() === 'dark';
    toggle.querySelector('.tt-label').textContent = dark ? 'Light mode' : 'Dark mode';
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.removeAttribute('data-off');
  }
  if (toggle) {
    toggle.addEventListener('click', () => {
      const next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('fl-theme', next); } catch (e) { /* storage blocked: the choice lasts until reload */ }
      paint();
      document.dispatchEvent(new CustomEvent('fl:theme', { detail: next }));
    });
    scheme.addEventListener('change', paint);
    paint();
  }

  // <button data-copy="#id"> copies that element's text
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const el = document.querySelector(b.dataset.copy);
      if (!el) return;
      try { await navigator.clipboard.writeText(el.textContent.trim()); }
      catch (e) { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
      b.classList.add('is-done');
      b.setAttribute('aria-label', 'Copied');
      setTimeout(() => { b.classList.remove('is-done'); b.setAttribute('aria-label', 'Copy the command'); }, 1600);
    });
  }
})();

/* ---- src/js/topbar.js ---- */
/* Top bar: nothing needs a script. The colour toggle lives in base.js. */

/* ---- src/js/hero.js ---- */
/* Hero: the survey sheet.
 *
 *   1. the cursor readout: the real file and line under the pointer, from window.FL_READOUT (assets/readout.js)
 *   2. pointer, touch and keyboard input, and the link into the live map
 *   3. the load sequence: neatline, formations, roads in stage order, cartouche (seekable, so it can be checked frame by frame)
 *   4. one slow survey sweep along real roads, then stillness
 *
 * Nothing here draws the map: every box and road is already in the page as SVG. This only reveals it and reads it.
 * With scripts off, or with reduced motion, the whole sheet is simply there. */
(() => {
  'use strict';
  const sheet = document.getElementById('hero-sheet');
  const neatline = document.getElementById('hero-neatline');
  const hero = document.getElementById('hero-map');
  if (!sheet || !neatline || !hero || !window.FL_READOUT) { if (sheet) sheet.classList.remove('hero-pre'); return; }

  const $ = (s, r = hero) => r.querySelector(s);
  const live = $('.ly-live'), formG = [...$('.ly-formations').children];
  const boxRects = [...$('.ly-boxes').querySelectorAll('rect')];
  const VB = $('.ly-boxes').viewBox.baseVal, W = VB.width, H = VB.height;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const coarse = matchMedia('(hover: none), (pointer: coarse)');
  const phone = matchMedia('(max-width: 639px)');
  const foot = document.getElementById('hero-foot');
  const el = {
    readout: document.getElementById('hero-readout'), where: foot.querySelector('.ro-where'),
    open: foot.querySelector('.ro-open'), say: document.getElementById('hero-live'),
    boxHl: $('.box-hl', live), stageHl: $('.stage-hl', live), label: $('.stage-label', live), sweep: $('.sweep', live),
  };
  const ro = { idle: el.readout.querySelector('.ro-idle'), live: el.readout.querySelector('.ro-live') };
  const LIVE_MAP = el.open.getAttribute('href');

  /* ---- the spatial index: a uniform grid over the boxes. A lookup touches a handful of cells, so it is instant at 3519 boxes. */
  const N = boxRects.length, bx = new Float32Array(N), by = new Float32Array(N), bw = new Float32Array(N), bh = new Float32Array(N);
  const boxStage = new Uint8Array(N), stageFirst = [];
  const stages = formG.map((g, i) => {
    const r = g.firstElementChild;
    return { id: g.id, title: g.dataset.title, x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'), g, fm: g.getAttribute('class').match(/fm-(\d)/)[1], i };
  });
  const stageIndex = new Map(stages.map((s) => [s.id, s.i]));
  boxRects.forEach((r, i) => {
    bx[i] = +r.getAttribute('x'); by[i] = +r.getAttribute('y'); bw[i] = +r.getAttribute('width'); bh[i] = +r.getAttribute('height');
    const si = stageIndex.get(r.parentNode.dataset.stage);
    boxStage[i] = si;
    if (stageFirst[si] === undefined) stageFirst[si] = i;
  });
  const CELL = 400, GX = Math.ceil(W / CELL), GY = Math.ceil(H / CELL), grid = new Array(GX * GY);
  for (let i = 0; i < N; i++) {
    for (let cy = Math.max(0, Math.floor(by[i] / CELL)); cy <= Math.min(GY - 1, Math.floor((by[i] + bh[i]) / CELL)); cy++) {
      for (let cx = Math.max(0, Math.floor(bx[i] / CELL)); cx <= Math.min(GX - 1, Math.floor((bx[i] + bw[i]) / CELL)); cx++) (grid[cy * GX + cx] ||= []).push(i);
    }
  }
  // the box nearest to (x, y) within r map units, or -1. A point inside a box is at distance 0.
  function nearest(x, y, r) {
    let best = -1, bd = Infinity;
    for (let cy = Math.max(0, Math.floor((y - r) / CELL)); cy <= Math.min(GY - 1, Math.floor((y + r) / CELL)); cy++) {
      for (let cx = Math.max(0, Math.floor((x - r) / CELL)); cx <= Math.min(GX - 1, Math.floor((x + r) / CELL)); cx++) {
        const cell = grid[cy * GX + cx]; if (!cell) continue;
        for (const i of cell) {
          const dx = Math.max(bx[i] - x, 0, x - bx[i] - bw[i]), dy = Math.max(by[i] - y, 0, y - by[i] - bh[i]), d = dx * dx + dy * dy;
          if (d < bd) { bd = d; best = i; }
        }
      }
    }
    return bd <= r * r ? best : -1;
  }
  const stageAt = (x, y) => stages.findIndex((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
  // the nearest box in a direction (dx, dy is a unit step), widening the search until something is found
  function neighbour(i, dx, dy) {
    const cx = bx[i] + bw[i] / 2, cy = by[i] + bh[i] / 2;
    for (let R = 1200; R <= 40000; R *= 2) {
      let best = -1, bs = Infinity;
      for (let gy = Math.max(0, Math.floor((cy - R) / CELL)); gy <= Math.min(GY - 1, Math.floor((cy + R) / CELL)); gy++) {
        for (let gx = Math.max(0, Math.floor((cx - R) / CELL)); gx <= Math.min(GX - 1, Math.floor((cx + R) / CELL)); gx++) {
          for (const j of grid[gy * GX + gx] || []) {
            if (j === i) continue;
            const ox = bx[j] + bw[j] / 2 - cx, oy = by[j] + bh[j] / 2 - cy, along = ox * dx + oy * dy, across = Math.abs(ox * dy - oy * dx);
            if (along <= 40 || across > along * 1.6 + 300) continue;
            const s = along + across * 2.2;
            if (s < bs) { bs = s; best = j; }
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  /* ---- the readout */
  const T = window.FL_READOUT;
  let cur = -1, curStage = -1, scale = 1, box = null;
  const measure = () => { box = $('.ly-boxes').getBoundingClientRect(); scale = box.width / W; };
  // the live map opens at the chart that holds the box, on the box: #chart=c1230&node=f1230.0 (a split function: c1334p2)
  const chartOf = (id) => T.charts[id] || 'c' + id.slice(1).split('.')[0];
  const link = (id) => `${LIVE_MAP.split('#')[0]}#chart=${chartOf(id)}&node=${encodeURIComponent(id)}`;
  const describe = (i) => { const r = T.rows[i]; return { loc: `${T.files[r[1]]}:${r[2]}`, kind: T.kinds[r[0]], id: boxRects[i].id }; };

  function showStage(si) {
    if (si === curStage) return;
    if (curStage >= 0) stages[curStage].g.classList.remove('on');
    curStage = si;
    hero.classList.toggle('has-stage', si >= 0);
    if (si < 0) { el.where.hidden = true; return; }
    const s = stages[si];
    s.g.classList.add('on');
    el.stageHl.setAttribute('x', s.x); el.stageHl.setAttribute('y', s.y); el.stageHl.setAttribute('width', s.w); el.stageHl.setAttribute('height', s.h);
    el.label.textContent = s.title;
    el.label.setAttribute('x', s.x + 90); el.label.setAttribute('y', s.y + 440);
    const room = W - 120 - (s.x + 90), len = el.label.getComputedTextLength ? el.label.getComputedTextLength() : 0;   // keep the name on the sheet
    if (len > room) el.label.setAttribute('x', Math.max(60, W - 120 - len));
    el.where.hidden = false;
    el.where.querySelector('.ro-stage').textContent = s.title;
    el.where.style.setProperty('--f', `var(--fm-${s.fm})`);
    el.where.style.setProperty('--e', `var(--fm-${s.fm}-edge)`);
  }

  function showBox(i, speak) {
    if (i === cur) return;
    cur = i;
    hero.classList.toggle('has-box', i >= 0);
    if (i < 0) { ro.live.hidden = true; ro.idle.hidden = false; el.open.hidden = true; return; }
    const L = describe(i), pad = 3.5 / scale;
    el.boxHl.setAttribute('x', bx[i] - pad); el.boxHl.setAttribute('y', by[i] - pad);
    el.boxHl.setAttribute('width', bw[i] + 2 * pad); el.boxHl.setAttribute('height', bh[i] + 2 * pad);
    el.boxHl.setAttribute('rx', 11 + pad);
    ro.idle.hidden = true; ro.live.hidden = false;
    ro.live.querySelector('.ro-loc').textContent = L.loc;
    ro.live.querySelector('.ro-kind').textContent = L.kind;
    ro.live.querySelector('.ro-id').textContent = L.id;
    el.open.hidden = false; el.open.href = link(L.id);
    if (speak) el.say.textContent = `${L.loc}, ${L.kind}, ${L.id}, in ${stages[boxStage[i]].title}`;
  }

  function point(x, y, r) {            // x, y in map units; r is the reach in map units
    const i = nearest(x, y, r);
    showStage(i >= 0 ? boxStage[i] : stageAt(x, y));     // a box wins: the stage named is the stage that box belongs to
    showBox(i, false);
    mark(x / W, y / H);
  }
  // ticks on the neatline show where on the sheet the pointer is. They are leaf elements, so moving them costs no style work on the map.
  const tickX = neatline.querySelector('.tick-x'), tickY = neatline.querySelector('.tick-y');
  function mark(fx, fy) {
    tickX.style.setProperty('--cx', clamp01(fx).toFixed(4)); tickY.style.setProperty('--cy', clamp01(fy).toFixed(4));
    neatline.classList.add('is-reading');
  }
  function leave() { neatline.classList.remove('is-reading'); showStage(-1); showBox(-1); }

  /* ---- input */
  let want = null, queued = false, key = false;
  const flush = () => { queued = false; if (!want) return; const w = want; want = null; measure(); point((w.x - box.left) / scale, (w.y - box.top) / scale, (w.touch ? 24 : 13) / scale); };
  const ask = (e, touch) => { want = { x: e.clientX, y: e.clientY, touch }; if (!queued) { queued = true; requestAnimationFrame(flush); } };

  hero.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    key = false; stopSweep();
    ask(e, false);
  });
  hero.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch' && !key) { want = null; leave(); } });
  hero.addEventListener('click', (e) => {
    if (coarse.matches) { ask(e, true); return; }     // a tap selects; the readout then offers the link
    if (cur >= 0) el.open.click();                    // a click on a box opens it on the live map
  });

  // keyboard: arrows hop to the nearest box that way, Page Up and Down to the next stage, Home and End to the ends, Enter opens, Escape lets go
  const KEYS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };
  function goTo(to) {
    if (to < 0) return;
    key = true; stopSweep(); measure();
    showStage(boxStage[to]); showBox(to, true);
    mark((bx[to] + bw[to] / 2) / W, (by[to] + bh[to] / 2) / H);
    const sc = $('.map-scroll');                      // on a phone, bring the box into view
    if (sc.scrollWidth > sc.clientWidth + 1) sc.scrollLeft = (bx[to] / W) * sc.scrollWidth - sc.clientWidth / 2;
  }
  hero.addEventListener('keydown', (e) => {
    if (e.target !== hero || e.altKey || e.ctrlKey || e.metaKey) return;
    let to;
    if (KEYS[e.key]) to = cur < 0 ? 0 : neighbour(cur, ...KEYS[e.key]);
    else if (e.key === 'PageDown' || e.key === ']') to = stageFirst[Math.min(stages.length - 1, (cur < 0 ? -1 : boxStage[cur]) + 1)];
    else if (e.key === 'PageUp' || e.key === '[') to = stageFirst[Math.max(0, (cur < 0 ? 1 : boxStage[cur]) - 1)];
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = N - 1;
    else if (e.key === 'Enter' || e.key === ' ') { if (cur >= 0) { e.preventDefault(); el.open.click(); } return; }
    else if (e.key === 'Escape') { leave(); hero.blur(); return; }
    else return;
    e.preventDefault();
    goTo(to);
  });
  hero.addEventListener('focus', () => { if (cur < 0 && hero.matches(':focus-visible')) goTo(0); });   // tabbing in lands on the first box
  hero.addEventListener('blur', () => { if (key) { key = false; leave(); } });
  addEventListener('resize', measure, { passive: true });
  const idle = () => { ro.idle.textContent = el.readout.dataset[coarse.matches ? 'idleTouch' : 'idle']; };
  idle(); if (coarse.addEventListener) coarse.addEventListener('change', idle);
  measure();

  /* ---- the load sequence. frame(t) is a pure function of t (milliseconds), so it can be played, or sought to any moment.
   *   neatline draws round the sheet     0 to 710
   *   formations wash in, stage by stage 140 to 1200
   *   roads draw along their paths       360 to 1780, stage by stage, then the long roads between stages to 2050
   *   boxes appear with their stage      300 to 1440
   *   the cartouche settles last         1700 to 2150
   * (milliseconds of the score; it plays at 0.93 speed, so it ends at 2000)                                */
  const TS = 0.93;                                  // the times below are the score; this plays it a little faster
  const END = Math.round(2150 * TS);                // 2000 ms
  const seg = (t, a, d) => clamp01((t - a) / d);
  const easeOut = (x) => 1 - (1 - x) * (1 - x);
  const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const sides = [['.nl-top', 0, 'scaleX'], ['.nl-right', 110, 'scaleY'], ['.nl-bottom', 220, 'scaleX'], ['.nl-left', 330, 'scaleY']].map(([s, a, f]) => ({ n: neatline.querySelector(s), a, f }));
  const cartouche = document.getElementById('hero-cartouche') || { style: {} };   // the BullMQ page has no cartouche
  const boxG = [...$('.ly-boxes').children];
  let roads = null, raf = 0, t0 = 0, prepareMs = 0;

  function prepare() {                       // measure every road once; solid ones are drawn with a dash as long as the road
    if (roads) return;
    const p0 = performance.now();
    measure();
    roads = [];
    const total = hero.querySelectorAll('.ly-roads path').length, bulk = total > 5000;   // a very large map: each stage's roads fade in as one group, not one by one
    for (const g of $('.ly-roads').children) {
      const between = g.classList.contains('between'), si = between ? -1 : stageIndex.get(g.dataset.stage), n = g.children.length;
      if (bulk) { roads.push({ p: g, len: 0, dashed: true, a: between ? 950 : 360 + si * 32, d: between ? 700 : 520, v: -1 }); continue; }
      [...g.children].forEach((p, j) => {
        const len = p.getTotalLength() * scale, dashed = p.classList.contains('nc') || p.classList.contains('ret') || len < 1;
        roads.push({ p, len, dashed, a: between ? 950 + (j / n) * 400 : 360 + si * 32 + (j / n) * 240, d: between ? 700 : 420, v: -1 });
      });
    }
    prepareMs = performance.now() - p0;
  }
  function frame(t) {
    t /= TS;
    for (const s of sides) { const v = easeInOut(seg(t, s.a, 380)); s.n.style.transform = `${s.f}(${v})`; s.n.style.opacity = v > 0 ? 1 : 0; }
    stages.forEach((s, i) => { s.g.style.opacity = easeOut(seg(t, 140 + i * 28, 380)); });
    for (const r of roads) {
      const v = seg(t, r.a, r.d);
      if (v === r.v) continue;
      r.v = v;
      if (r.dashed) r.p.style.opacity = v;                                 // dashed roads fade in, so their dashes stay dashes
      else if (v >= 1) { r.p.style.strokeDasharray = ''; r.p.style.strokeDashoffset = ''; }
      else { r.p.style.strokeDasharray = `${r.len}px ${r.len}px`; r.p.style.strokeDashoffset = `${r.len * (1 - easeOut(v))}px`; }
    }
    boxG.forEach((g, i) => { g.style.opacity = easeOut(seg(t, 300 + stageIndex.get(g.dataset.stage) * 34, 360)); });
    const c = easeOut(seg(t, 1700, 450));
    cartouche.style.opacity = c; cartouche.style.transform = `translateY(${(1 - c) * 10}px)`;
  }
  function begin() { prepare(); hero.classList.add('hero-intro'); sheet.classList.remove('hero-pre'); }
  function finish() {                        // leave no inline style behind: what is left is exactly the static page
    cancelAnimationFrame(raf);
    for (const s of sides) { s.n.style.transform = ''; s.n.style.opacity = ''; }
    for (const s of stages) s.g.style.opacity = '';
    if (roads) for (const r of roads) r.p.removeAttribute('style');
    for (const g of boxG) g.style.opacity = '';
    cartouche.style.opacity = ''; cartouche.style.transform = '';
    hero.classList.remove('hero-intro'); sheet.classList.remove('hero-pre');
    document.documentElement.classList.add('hero-ready');
    if (window.FL_HERO && !window.FL_HERO.drawnAt) window.FL_HERO.drawnAt = performance.now();
    document.dispatchEvent(new CustomEvent('fl:hero-drawn'));
    armSweep();
  }
  function play() {
    begin(); frame(0);
    t0 = performance.now(); window.FL_HERO.startedAt = t0;
    const tick = (now) => { const t = now - t0; if (t >= END) { frame(END); finish(); } else { frame(t); raf = requestAnimationFrame(tick); } };
    raf = requestAnimationFrame(tick);
  }

  /* ---- one slow survey sweep along the real roads of the longest unbroken chain, in fault red. It names the stages it crosses, then stops. */
  const sweepHead = $('.sweep-head', live);
  const SWEEP = { ms: 6500, hold: 900 };
  let sw = null, swept = false, armed = false;
  function sweepTick(now) {
    const t = now - sw.t0, e = easeInOut(clamp01(t / SWEEP.ms));
    el.sweep.style.strokeDashoffset = `${sw.L * (1 - e)}px`;
    const pt = el.sweep.getPointAtLength(sw.len * e);
    sweepHead.setAttribute('cx', pt.x); sweepHead.setAttribute('cy', pt.y); sweepHead.setAttribute('r', 6 / scale);
    showStage(stageAt(pt.x, pt.y));
    if (t > SWEEP.ms + SWEEP.hold) { stopSweep(); return; }
    sw.raf = requestAnimationFrame(sweepTick);
  }
  function startSweep() {
    if (sw || swept || reduce.matches || phone.matches || key || document.hidden) return;
    swept = true; measure();
    const len = el.sweep.getTotalLength(), L = len * scale;
    el.sweep.style.strokeDasharray = `${L}px ${L * 2}px`; el.sweep.style.strokeDashoffset = `${L}px`;
    hero.classList.add('is-sweeping');
    sw = { t0: performance.now(), len, L, raf: 0 };
    sw.raf = requestAnimationFrame(sweepTick);
  }
  function stopSweep() {
    if (!sw) return;
    cancelAnimationFrame(sw.raf); sw = null;
    hero.classList.remove('is-sweeping');                 // the CSS transition fades the line out
    if (cur < 0) showStage(-1);
    setTimeout(() => { if (!sw) { el.sweep.removeAttribute('style'); sweepHead.setAttribute('r', 0); } }, 450);
  }
  function armSweep() {                                    // a moment after the draw-in, once the sheet is on screen
    if (reduce.matches || phone.matches || !('IntersectionObserver' in window)) return;
    setTimeout(() => {
      armed = true;
      const io = new IntersectionObserver((es) => { if (armed && es.some((x) => x.isIntersecting)) { io.disconnect(); startSweep(); } }, { threshold: 0.6 });
      io.observe(hero);
    }, 1400);
  }

  /* ---- boot. ?hero=manual stops it playing by itself so a check can seek to any moment: FL_HERO.seek(ms). */
  window.FL_HERO = {
    END, drawnAt: 0, startedAt: 0, get prepareMs() { return prepareMs; },
    seek(t) { cancelAnimationFrame(raf); begin(); frame(t); },
    finish, pick: (x, y, r = 13) => { measure(); const i = nearest((x - box.left) / scale, (y - box.top) / scale, r / scale); return i < 0 ? null : { ...describe(i), href: link(boxRects[i].id) }; },
    sweep: startSweep, stopSweep, boxes: N,
  };
  if (/[?&]hero=manual\b/.test(location.search)) { prepare(); return; }
  if (reduce.matches || document.hidden) { finish(); return; }
  play();
})();

/* ---- src/js/tour.js ---- */
/* Tour: the video slot.
 * The recording is not published yet, so the file may not be there. The video asks for nothing until someone presses play (preload="none").
 * With a script: a play button over the poster, the poster follows the colour mode, and if the file is missing a plain message replaces the dead player.
 * Without a script: the browser's own controls over the same poster. */
(() => {
  const video = document.getElementById('tour-video');
  const play = document.getElementById('tour-play');
  const missing = document.getElementById('tour-missing');
  if (!video || !play || !missing) return;
  const root = document.documentElement;
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let started = false;

  const mode = () => root.getAttribute('data-theme') || (scheme.matches ? 'dark' : 'light');
  const poster = () => { if (!started) video.poster = `video/poster-${mode()}.webp`; };
  poster();
  document.addEventListener('fl:theme', poster);
  scheme.addEventListener('change', poster);

  // own the play control until the first play, then hand over to the browser's controls
  video.controls = false;
  play.hidden = false;

  const fail = () => {
    started = false; video.controls = false; video.hidden = false;
    play.hidden = true; missing.hidden = false;
  };
  // <source> errors do not bubble, so listen on the way down
  video.addEventListener('error', fail, true);

  play.addEventListener('click', () => {
    started = true; play.hidden = true; video.controls = true;
    const p = video.play();
    if (p && p.catch) p.catch((e) => { if (e && e.name !== 'AbortError') fail(); });
  });
  video.addEventListener('ended', () => { started = false; video.controls = false; play.hidden = false; play.querySelector('span').textContent = 'Play again'; poster(); });
})();

/* ---- src/js/how.js ---- */
/* How it works: draw the strata in as the figure scrolls into view, bottom first.
 * Each stratum gets --p (0 to 1) from the scroll position; the CSS scales its slab up from its own bottom edge. No timers: the picture follows the scroll, so it can be read at any position.
 * Without a script, or with reduced motion, every slab is simply there (how.css). */
(() => {
  const fig = document.getElementById('hw-fig');
  if (!fig) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const items = [...fig.querySelectorAll('.hw-st')].reverse();   // layer 1 (the bottom of the page order) first
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  let queued = false;
  function paint() {
    queued = false;
    const r = fig.getBoundingClientRect(), vh = innerHeight || 800;
    // 0 when the top of the figure is 92% of the way down the window; 1 when it has risen by 85% of its own height
    const t = Math.max(0, Math.min(1, (vh * 0.92 - r.top) / (r.height * 0.85)));
    items.forEach((li, k) => {
      const a = k * 0.15, p = Math.max(0, Math.min(1, (t - a) / 0.4));
      li.style.setProperty('--p', ease(p).toFixed(3));
    });
  }
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(paint); } };
  addEventListener('scroll', ask, { passive: true });
  addEventListener('resize', ask);
  paint();
})();

/* ---- src/js/explanation.js ---- */
/* Explanation: the fault line is drawn when it scrolls into view, one way after another (solid, dashed, queried).
 * Without a script, or with reduced motion, the CSS leaves it fully drawn. Nothing else on this section needs a script. */
(() => {
  const fault = document.getElementById('ex-fault');
  if (!fault || !('IntersectionObserver' in window)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  fault.classList.add('is-armed');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      // two frames so the armed state has been painted before the transition starts
      requestAnimationFrame(() => requestAnimationFrame(() => fault.classList.add('is-drawn')));
      io.disconnect();
    }
  }, { threshold: 0.6 });
  io.observe(fault);
})();

/* ---- src/js/readers.js ---- */
/* Two readers: point at a box on the chart, read what an agent would be told about it.
 *
 * Everything is already in the page: the chart is inline SVG, and the terminal holds the real `faultline where` output for
 * every box, stacked in one grid cell. This script only moves one class from box to box, so a change is instant and a
 * repeat hover costs the same as the first. Nothing is typed out and nothing is fetched.
 *
 *   hover, focus or tap a box   its roads and their labels light up, its id shows on the chart and in the terminal
 *   the ids in the terminal     hover shows that box on the chart, a click walks there
 *   arrow keys                  move to the nearest box in that direction (Tab reaches every box too)
 *
 * With scripts off the chart and the terminal for the first box are simply there. */
(() => {
  'use strict';
  const sheet = document.getElementById('rd-chart');
  const term = document.getElementById('rd-term');
  if (!sheet || !term) return;
  const svg = sheet.querySelector('svg.chart');
  const flag = document.getElementById('rd-flag');
  const say = document.getElementById('rd-say');
  const vb = svg.viewBox.baseVal;

  const nodes = new Map(), outs = new Map(), spot = new Map();
  for (const g of svg.querySelectorAll('.node')) {
    const r = g.querySelector('.node-box');
    const x = +r.getAttribute('x'), y = +r.getAttribute('y'), w = +r.getAttribute('width'), h = +r.getAttribute('height');
    nodes.set(g.dataset.node, g);
    spot.set(g.dataset.node, { x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
    g.setAttribute('tabindex', '0');
    g.setAttribute('role', 'button');
  }
  for (const o of term.querySelectorAll('.out')) outs.set(o.dataset.for, o);
  svg.setAttribute('role', 'group');   // with scripts on it is a set of buttons, not one picture
  const edges = [...svg.querySelectorAll('.edge')].map((g) => ({
    g, path: g.firstElementChild, from: g.dataset.from, to: g.dataset.to, nc: g.classList.contains('nc'),
    label: svg.querySelector(`.elabel[data-edge-label="${g.dataset.edge}"]`),
  }));
  const edgeById = new Map(edges.map((e) => [e.g.dataset.edge, e]));
  for (const el of term.querySelectorAll('.id')) { el.setAttribute('role', 'button'); el.setAttribute('tabindex', '0'); }

  let cur = term.dataset.start, ghost = null;

  // the id flag hangs below its box (above it if the box is near the bottom edge), in percent of the chart
  function placeFlag(id) {
    const s = spot.get(id);
    if (!s) { flag.hidden = true; return; }
    flag.textContent = id;
    flag.hidden = false;
    const above = vb.y + vb.height - (s.y + s.h) < 60;
    flag.style.left = ((s.x - vb.x) / vb.width) * 100 + '%';
    flag.style.top = ((above ? s.y : s.y + s.h) - vb.y) / vb.height * 100 + '%';
    flag.style.transform = above ? 'translate(0, calc(-100% - 3px))' : 'translate(0, 3px)';
  }

  function show(id, announce) {
    if (!nodes.has(id) || id === cur) { if (announce && id === cur) tell(id); return; }
    nodes.get(cur).classList.remove('is-cur');
    const was = outs.get(cur);
    was.classList.remove('is-cur'); was.setAttribute('aria-hidden', 'true');
    cur = id;
    nodes.get(cur).classList.add('is-cur');
    const now = outs.get(cur);
    now.classList.add('is-cur'); now.removeAttribute('aria-hidden');
    for (const e of edges) {
      const on = e.from === id || e.to === id;
      e.g.classList.toggle('is-on', on);
      if (e.label) e.label.classList.toggle('is-on', on);
      if (!e.nc) e.path.setAttribute('marker-end', `url(#${on ? 'rd-arr-on' : 'rd-arr'})`);
    }
    if (!ghost) placeFlag(cur);
    if (announce) tell(id);
  }
  function tell(id) { say.textContent = nodes.get(id).getAttribute('aria-label') + ' Its where output is in the terminal.'; }

  // ---- the chart
  svg.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const g = e.target.closest('.node');
    if (g) show(g.dataset.node);
  });
  svg.addEventListener('click', (e) => { const g = e.target.closest('.node'); if (g) show(g.dataset.node, true); });
  svg.addEventListener('focusin', (e) => { const g = e.target.closest('.node'); if (g) show(g.dataset.node, true); });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.node');
    if (!g) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(g.dataset.node, true); return; }
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir) return;
    e.preventDefault();
    const from = spot.get(g.dataset.node);
    let best = null, bd = Infinity;
    for (const [id, s] of spot) {
      if (id === g.dataset.node) continue;
      const dx = s.cx - from.cx, dy = s.cy - from.cy, along = dx * dir[0] + dy * dir[1], across = Math.abs(dx * dir[1] - dy * dir[0]);
      if (along <= 4) continue;
      const d = along + across * 2.2;
      if (d < bd) { bd = d; best = id; }
    }
    if (best) nodes.get(best).focus();
  });

  // ---- the terminal: its ids are links into the chart
  const unghost = () => {
    if (!ghost) return;
    const { box, edge } = ghost; ghost = null;
    if (box) box.classList.remove('is-ghost');
    if (edge) edge.g.classList.remove('is-pick');
    placeFlag(cur);
  };
  term.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const t = e.target.closest('.id, .rid');
    if (!t) { unghost(); return; }
    unghost();
    if (t.dataset.box) { ghost = { box: nodes.get(t.dataset.box) }; ghost.box.classList.add('is-ghost'); placeFlag(t.dataset.box); }
    else { ghost = { edge: edgeById.get(t.dataset.road) }; if (ghost.edge) ghost.edge.g.classList.add('is-pick'); }
  });
  term.addEventListener('pointerleave', unghost);
  term.addEventListener('click', (e) => { const t = e.target.closest('.id'); if (t) { unghost(); show(t.dataset.box, true); } });
  term.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.id')) { e.preventDefault(); unghost(); show(e.target.dataset.box, true); } });

  placeFlag(cur);
})();

/* ---- src/js/zoom.js ---- */
/* Zoom: scrubbed by scroll, whole system to one line of code.
 * One camera: a view rectangle in map units, set as the viewBox of one SVG, from the scroll position. Four key views (data/zoom/views.json, built from the real map):
 * the whole map, the stage, the chart's tile, the box. Layers fade into each other by how wide the view is: a picture of the whole map far out, the stage's boxes and roads
 * nearer, the product's own drawing of the chart (text and all) close in. Only the viewBox changes per frame, and only when the scroll moved.
 * Not used on a phone, with reduced motion, or without a script: the four stepped frames show instead. */
(() => {
  const track = document.getElementById('zm-track'), svg = document.getElementById('zm-svg'), frame = document.getElementById('zm-frame');
  if (!track || !svg || !frame) return;
  const root = document.documentElement;
  const wide = matchMedia('(min-width: 900px) and (min-height: 520px)'), still = matchMedia('(prefers-reduced-motion: reduce)');
  const $ = (id) => document.getElementById(id);
  const uFm = $('zm-u-fm'), uDetail = $('zm-u-detail'), uChart = $('zm-u-chart'), uName = $('zm-u-name'), imgL = $('zm-whole'), imgD = $('zm-whole-d'), hl = $('zm-hl');
  const code = frame.querySelector('.zm-code'), scaleEl = $('zm-scale'), nEl = $('zm-n'), capEl = $('zm-cap'), ticks = [...document.querySelectorAll('.zm-ticks li')];
  const caps = [...document.querySelectorAll('.zs-step figcaption')].map((f) => f.textContent.replace(/^\d+/, '').trim());
  let V = null, ready = false, raf = 0, last = -1;

  try { V = JSON.parse(document.getElementById('zm-views').textContent); ready = true; } catch (e) { /* no views: the stepped frames stay */ }

  const live = () => { const on = wide.matches && !still.matches; root.classList.toggle('zm-live', on); if (on) ask(); };
  [wide, still].forEach((m) => m.addEventListener('change', live));
  live();

  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const sm = (x) => x * x * (3 - 2 * x);
  const lerp = (a, b, t) => a + (b - a) * t;
  // 0 at the view width a, 1 at the width b (on a log scale, so a ten times closer view takes the same scroll as a ten times wider one)
  const lg = (w, a, b) => clamp((Math.log(w) - Math.log(a)) / (Math.log(b) - Math.log(a)));
  // scroll positions of the four key views: hold, move, hold, move, hold, move, hold
  const KEYS = [0, 0.3, 0.62, 0.92];
  const HOLD = 0.07;

  function fit(v, A, bias) {       // keep the centre, widen the shorter side so the view has the frame's shape; a bias moves the box off-centre, to make room for the code card
    let cx = v[0] + v[2] / 2, cy = v[1] + v[3] / 2;
    let w = v[2], h = v[3];
    if (w / h < A) w = h * A; else h = w / A;
    if (bias) { cx += w * bias[0]; cy += h * bias[1]; }
    return [cx, cy, w];
  }
  function view(p, A) {
    const F = V.views.map((v, i) => fit(v, A, i === 3 ? [0.15, 0.12] : null));
    let i = 0; while (i < 2 && p > KEYS[i + 1]) i++;
    const a = KEYS[i] + (i === 0 ? 0 : HOLD / 2), b = KEYS[i + 1] - HOLD / 2;
    const t = sm(clamp((p - a) / (b - a)));
    const s = F[i], e = F[i + 1];
    const w = Math.exp(lerp(Math.log(s[2]), Math.log(e[2]), t));
    return { cx: lerp(s[0], e[0], t), cy: lerp(s[1], e[1], t), w, F, step: p < (KEYS[i] + KEYS[i + 1]) / 2 ? i : i + 1 };
  }

  function paint() {
    raf = 0;
    if (!ready || !root.classList.contains('zm-live')) return;
    const r = track.getBoundingClientRect(), span = r.height - (innerHeight - 60);
    const p = clamp(-r.top / Math.max(1, span));
    if (Math.abs(p - last) < 0.0002) return;
    last = p;
    const A = frame.clientWidth / frame.clientHeight || 2;
    const c = view(p, A), h = c.w / A;
    svg.setAttribute('viewBox', `${(c.cx - c.w / 2).toFixed(1)} ${(c.cy - h / 2).toFixed(1)} ${c.w.toFixed(1)} ${h.toFixed(1)}`);
    const F2 = c.F[1][2], F3 = c.F[2][2], F4 = c.F[3][2], w = c.w;
    const whole = lg(w, F2 * 1.05, F2 * 2.4);                    // the picture of the whole map
    const stage = 1 - lg(w, F2 * 1.5, F2 * 3.6);                 // the stage's region appears over it
    const detail = stage * lg(w, F3 * 1.0, F3 * 1.9);            // its boxes and roads, until the chart replaces them
    const chart = 1 - lg(w, F3 * 1.12, F3 * 2.1);                // the product's own drawing of the chart
    imgL.style.opacity = imgD.style.opacity = whole.toFixed(3);
    uFm.style.opacity = Math.max(stage, chart).toFixed(3);
    uDetail.style.opacity = detail.toFixed(3);
    uChart.style.opacity = chart.toFixed(3);
    uName.style.opacity = (stage * lg(w, F2 * 0.55, F2 * 1.0)).toFixed(3);          // the stage's name, until the view is inside it
    hl.setAttribute('x', V.box[0] - 6); hl.setAttribute('y', V.box[1] - 6); hl.setAttribute('width', V.box[2] + 12); hl.setAttribute('height', V.box[3] + 12);
    hl.style.opacity = (1 - lg(w, F4 * 1.1, F4 * 2.2)).toFixed(3);
    if (code) code.style.opacity = (1 - lg(w, F4 * 1.1, F4 * 1.7)).toFixed(3);
    const k = V.size[0] / w;
    scaleEl.textContent = 'Scale x' + (k < 10 ? k.toFixed(1) : Math.round(k));
    if (c.step !== frame._step) {
      frame._step = c.step;
      nEl.textContent = c.step + 1; capEl.textContent = caps[c.step] || '';
      ticks.forEach((t, j) => t.classList.toggle('on', j === c.step));
    }
  }
  function ask() { if (!raf) raf = requestAnimationFrame(paint); }
  addEventListener('scroll', ask, { passive: true });
  addEventListener('resize', () => { last = -1; ask(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { last = -1; ask(); }).observe(frame);
  document.addEventListener('fl:theme', ask);
})();

/* ---- src/js/question.js ---- */
/* The question: the bar is drawn when it scrolls into view. Without a script, or with reduced motion, it is simply there. */
(() => {
  const chart = document.getElementById('qu-chart');
  if (!chart || !('IntersectionObserver' in window)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  chart.classList.add('is-armed');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      requestAnimationFrame(() => requestAnimationFrame(() => chart.classList.add('is-drawn')));
      io.disconnect();
    }
  }, { threshold: 0.5 });
  io.observe(chart.querySelector('.qu-bar') || chart);
})();

/* ---- src/js/programs.js ---- */
/* Programs draw: replay the two recorded terminals when they scroll into view.
 * The text is already in the page, exactly as recorded. This script only decides when each line is shown: it never writes, edits or computes a line.
 * Split terminals play both columns in step, row by row, so each line appears level with its twin. A Replay button plays it again.
 * Without a script, or with reduced motion, everything is simply there. */
(() => {
  const terms = [...document.querySelectorAll('.sec-programs .pg-term')];
  if (!terms.length || !('IntersectionObserver' in window)) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setup(term) {
    const split = term.querySelector('.pg-split');
    const rows = split ? +getComputedStyle(split).getPropertyValue('--rows') || 0 : 0;
    const cols = split ? [...split.children] : [];
    const wide = [...term.querySelectorAll('.pg-wide > *')];
    const all = [...term.querySelectorAll('.pg-head, .ln, .pg-comb')];
    const btn = term.querySelector('.pg-replay');
    let token = 0;

    // type a command in, one character at a time, when it sits on a single line (monospace: steps = characters)
    const type = (line, ms) => {
      const cmd = line && line.querySelector('.pg-cmd');
      if (!cmd || cmd.getClientRects().length !== 1) return 0;
      const n = cmd.textContent.length, d = Math.min(ms, Math.max(260, n * 14));
      cmd.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: d, easing: `steps(${n}, end)`, fill: 'both' });
      return d;
    };
    const on = (el) => el && el.classList.add('is-on');

    async function play() {
      const me = ++token;
      const live = () => me === token;
      for (const el of term.querySelectorAll('.is-on')) el.classList.remove('is-on');
      for (const el of term.querySelectorAll('.pg-cmd')) el.getAnimations().forEach((a) => a.cancel());
      term.classList.add('is-armed');
      await sleep(250); if (!live()) return;

      if (rows) {
        // the grid is filled column by column: column 1 is cols[0 .. rows-1], column 2 is cols[rows .. 2*rows-1]
        for (let r = 0; r < rows; r++) {
          const a = cols[r], b = cols[rows + r];
          if (!a) break;
          on(a); on(b);
          const isCmd = a.classList.contains('ln-cmd'), isHot = a.classList.contains('ln-hot') || (b && b.classList.contains('ln-hot'));
          const d = isCmd ? Math.max(type(a, 700), type(b, 700)) : 0;
          await sleep(isCmd ? d + 220 : isHot ? 320 : a.classList.contains('pg-head') ? 160 : 34);
          if (!live()) return;
        }
      }
      for (const el of wide) {
        if (el.classList.contains('pg-pair')) {
          const [x, comb, y] = el.children;
          on(x); await sleep(70); on(y); await sleep(90); on(comb); await sleep(260);
        } else {
          on(el);
          const d = el.classList.contains('ln-cmd') ? type(el, 700) : 0;
          await sleep(d ? d + 220 : 40);
        }
        if (!live()) return;
      }
      // anything not reached (a line added to the data later) is shown rather than left hidden
      for (const el of all) on(el);
    }

    if (btn) { btn.hidden = false; btn.addEventListener('click', play); }
    term.classList.add('is-armed');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.disconnect(); play(); }
    }, { threshold: 0.2, rootMargin: '0px 0px -10% 0px' });
    io.observe(term);
  }
  terms.forEach(setup);
})();

/* ---- src/js/notes.js ---- */
/* notes section: script. Wrap it in an IIFE; it is concatenated after base.js in section order. */

/* ---- src/js/limits.js ---- */
/* limits section: script. Wrap it in an IIFE; it is concatenated after base.js in section order. */

/* ---- src/js/not.js ---- */
/* not section: script. Wrap it in an IIFE; it is concatenated after base.js in section order. */

/* ---- src/js/run.js ---- */
/* run: tell a screen reader the command was copied, and keep the status line honest if the browser refused.
 * base.js does the copying and sets .is-done on the button; this only reads that back after it has had time to finish. */
(() => {
  const btn = document.querySelector('.rn-copy');
  const status = document.getElementById('run-status');
  if (!btn || !status) return;
  btn.addEventListener('click', () => {
    setTimeout(() => {
      status.textContent = btn.classList.contains('is-done')
        ? 'Copied the command to the clipboard.'
        : 'The command is selected. Press Ctrl+C or Cmd+C to copy it.';
      setTimeout(() => { status.textContent = ''; }, 3000);
    }, 300);
  });
})();

/* ---- src/js/footer.js ---- */
/* footer section: script. Wrap it in an IIFE; it is concatenated after base.js in section order. */

/* ---- src/js/layers.js ---- */
/* layers section: script. Wrap it in an IIFE; it is concatenated after base.js in section order. */
