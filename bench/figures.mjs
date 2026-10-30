#!/usr/bin/env node
// Draws the README figures from bench/results/*.json (real runs, nothing hand-placed):
//   docs/figures/bench-timeline.svg — every run replayed side by side (animated)
//   docs/figures/hx-flow.svg        — the Hx · 3 workers run replayed on its issue graph (animated)
//   docs/figures/bench-summary.svg  — wall time, tokens and hidden tests side by side
// The animations are plain CSS inside the SVG, so they play in a GitHub README with no GIF and no
// ffmpeg; they follow the viewer's light/dark theme and stop on prefers-reduced-motion (final state).
// Run: node bench/figures.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'docs', 'figures');
const CONFIGS = [
  { id: 'chat', name: 'Single session', note: 'one Claude session does all 6 issues in a row' },
  { id: 'hx1', name: 'Hx · 1 worker', note: 'a fresh session per issue, one at a time' },
  { id: 'hx3', name: 'Hx · 3 workers', note: 'fresh sessions, in parallel where Blocked by allows' },
];
const runs = CONFIGS.filter((c) => existsSync(path.join(here, 'results', `${c.id}.json`)))
  .map((c) => ({ ...c, r: JSON.parse(readFileSync(path.join(here, 'results', `${c.id}.json`), 'utf8')) }));
if (!runs.length) { console.error('no results in bench/results/'); process.exit(1); }
const issues = JSON.parse(readFileSync(path.join(here, 'issues.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const mtok = (n) => `${(n / 1e6).toFixed(2)}M`;
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
const COLORS = `
  :root { --bg:#ffffff; --panel:#f6f8fa; --border:#d0d7de; --fg:#1f2328; --muted:#656d76; --track:#eaeef2;
          --impl:#2f81f7; --decompose:#8250df; --review:#bf8700; --checkpoint:#cf222e; --chat:#57606a; --good:#1a7f37; --bad:#cf222e;
          --implbg:#ddf4ff; --goodbg:#dafbe1; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e; --track:#21262d;
            --impl:#4493f8; --decompose:#a371f7; --review:#d29922; --checkpoint:#f85149; --chat:#8b949e; --good:#3fb950; --bad:#f85149;
            --implbg:#0c2d6b; --goodbg:#0f3d1e; }
  }
  .bg { fill: var(--bg); } .panel { fill: var(--panel); stroke: var(--border); }
  .fg { fill: var(--fg); } .muted { fill: var(--muted); } .track { fill: var(--track); }
  .grid { stroke: var(--border); stroke-dasharray: 2 3; } .end { stroke: var(--fg); stroke-dasharray: 3 3; opacity: .6; }
  .good { fill: var(--good); } .bad { fill: var(--bad); }
  .impl { fill: var(--impl); } .decompose { fill: var(--decompose); } .review { fill: var(--review); }
  .checkpoint { fill: var(--checkpoint); } .chat { fill: var(--chat); }
  .label { fill: #ffffff; font-weight: 600; }
  .head { stroke: var(--fg); stroke-width: 1.5; }
  .grow { transform-box: fill-box; transform-origin: 0 50%; }
  .edge { fill: none; stroke: var(--border); stroke-width: 1.5; }
  .n-blocked { fill: var(--panel); stroke: var(--muted); stroke-dasharray: 4 3; }
  .n-ready { fill: var(--panel); stroke: var(--muted); }
  .n-working { fill: var(--implbg); stroke: var(--impl); stroke-width: 2; }
  .n-closed { fill: var(--goodbg); stroke: var(--good); }
  .t-working { fill: var(--impl); } .t-closed { fill: var(--good); }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }`;

/**
 * A real run replayed in REPLAY seconds, held for HOLD, looping. Every animated element gets its own
 * keyframes, computed from the recorded times. Each element's static style is its final state, so a
 * reader with reduced motion (or a renderer without CSS animation) sees the finished picture.
 */
function animator(maxMs, REPLAY = 14, HOLD = 4) {
  const CYCLE = REPLAY + HOLD;
  const frames = [];
  const p = (ms) => Math.max(0, Math.min(100, (Math.min(ms, maxMs) / maxMs) * (REPLAY / CYCLE) * 100));
  const add = (list) => {
    const name = `k${frames.length}`;
    frames.push(`@keyframes ${name} { ${list.map(([at, d]) => `${at.toFixed(3)}% { ${d} }`).join(' ')} }`);
    return `animation: ${name} ${CYCLE}s linear infinite`;
  };
  const eps = 0.001;
  return {
    css: () => frames.join('\n'),
    /** grows from nothing at `start` to full at `end` (with class "grow") */
    grow: (start, end) => add([[0, 'transform: scaleX(0)'], [p(start), 'transform: scaleX(0)'], [Math.max(p(end), p(start) + eps), 'transform: scaleX(1)'], [100, 'transform: scaleX(1)']]),
    /** visible during [a, b); b = Infinity = to the end of the cycle */
    during: (a, b = Infinity) => {
      const pa = p(a), pb = b === Infinity ? 101 : p(b);
      const l = [[0, `opacity: ${pa <= 0 ? 1 : 0}`]];
      if (pa > 0) l.push([pa, 'opacity: 0'], [Math.min(100, pa + eps), 'opacity: 1']);
      if (pb <= 100) l.push([pb, 'opacity: 1'], [Math.min(100, pb + eps), 'opacity: 0']);
      l.push([100, `opacity: ${pb <= 100 ? 0 : 1}`]);
      return add(l);
    },
    /** moves right by `dx` over the replay, then holds */
    sweep: (dx) => add([[0, 'transform: translateX(0px)'], [REPLAY / CYCLE * 100, `transform: translateX(${dx}px)`], [100, `transform: translateX(${dx}px)`]]),
  };
}
const svgDoc = (W, H, css, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>
<style>${COLORS}
${css}
</style>
<rect class="bg" width="${W}" height="${H}" rx="10"/>
${body}
</svg>
`;
mkdirSync(out, { recursive: true });

// ── timeline: every run replayed side by side ─────────────────────────────────────────────────
{
  const W = 960, left = 150, right = 210, plotW = W - left - right, laneH = 26, laneGap = 8;
  const maxMs = Math.max(...runs.map((x) => x.r.wallMs));
  const A = animator(maxMs);
  const step = maxMs > 40 * 60000 ? 10 : maxMs > 15 * 60000 ? 5 : 2; // minutes per tick
  const ticks = Math.ceil(maxMs / 60000 / step);
  const scale = plotW / (ticks * step * 60000);
  const x = (ms) => left + ms * scale;
  let y = 70;
  const parts = [];
  for (const { name, note, r } of runs) {
    const lanes = Math.max(1, ...r.timeline.map((t) => t.lane + 1));
    const h = 54 + lanes * (laneH + laneGap);
    parts.push(`<rect class="panel" x="16" y="${y}" width="${W - 32}" height="${h}" rx="8"/>`);
    parts.push(`<text class="fg" x="32" y="${y + 24}" font-size="15" font-weight="600">${esc(name)}</text>`);
    parts.push(`<text class="muted" x="${32 + name.length * 8.6 + 12}" y="${y + 24}" font-size="12">${esc(note)}</text>`);
    for (let l = 0; l < lanes; l++) {
      const ly = y + 40 + l * (laneH + laneGap);
      parts.push(`<text class="muted" x="32" y="${ly + 17}" font-size="12">${r.config === 'chat' ? 'session' : `worker ${l + 1}`}</text>`);
      parts.push(`<rect class="track" x="${left}" y="${ly}" width="${plotW}" height="${laneH}" rx="4"/>`);
    }
    for (const t of r.timeline) {
      const ly = y + 40 + t.lane * (laneH + laneGap);
      const bw = Math.max(3, (t.end - t.start) * scale - 2);
      const cls = r.config === 'chat' ? 'chat' : t.role;
      parts.push(`<rect class="${cls} grow" style="${A.grow(t.start, t.end)}" x="${x(t.start) + 1}" y="${ly + 2}" width="${bw}" height="${laneH - 4}" rx="3"><title>#${t.issue} ${t.role}: ${mins(t.end - t.start)}</title></rect>`);
      if (bw > 17) parts.push(`<text class="label" style="${A.during(t.end)}" x="${x(t.start) + 1 + bw / 2}" y="${ly + 17}" font-size="11" text-anchor="middle">#${t.issue}</text>`);
    }
    // the run's result appears the moment it finishes
    const done = A.during(r.wallMs);
    parts.push(`<line class="end" style="${done}" x1="${x(r.wallMs)}" x2="${x(r.wallMs)}" y1="${y + 34}" y2="${y + h - 8}"/>`);
    const sx = W - right + 20;
    parts.push(`<g style="${done}"><text class="fg" x="${sx}" y="${y + 50}" font-size="14" font-weight="600">${mins(r.wallMs)} ✓</text>`);
    parts.push(`<text class="muted" x="${sx}" y="${y + 68}" font-size="12">${mtok(r.tokens.total)} tokens</text>`);
    parts.push(`<text class="${r.hiddenPassed === 6 ? 'good' : 'bad'}" x="${sx}" y="${y + 86}" font-size="12">hidden tests ${r.hiddenPassed}/6</text></g>`);
    y += h + 14;
  }
  const axisY = y;
  const grid = [];
  for (let i = 0; i <= ticks; i++) {
    grid.push(`<line class="grid" x1="${x(i * step * 60000)}" x2="${x(i * step * 60000)}" y1="62" y2="${axisY - 10}"/>`);
    grid.push(`<text class="muted" x="${x(i * step * 60000)}" y="${axisY + 6}" font-size="11" text-anchor="middle">${i * step}m</text>`);
  }
  // playhead + a clock in real run time
  const head = `<line class="head" style="${A.sweep(x(maxMs) - left)}" x1="${left}" x2="${left}" y1="62" y2="${axisY - 10}"/>`;
  const clocks = [];
  for (let ms = 0; ms < maxMs; ms += 5000) clocks.push(`<text class="fg" style="${A.during(ms, ms + 5000)};opacity:0" x="${W - 20}" y="34" font-size="15" font-weight="600" text-anchor="end">t = ${clock(ms)}</text>`);
  clocks.push(`<text class="fg" style="${A.during(maxMs)}" x="${W - 20}" y="34" font-size="15" font-weight="600" text-anchor="end">t = ${clock(maxMs)} · all done</text>`);
  const H = axisY + 40;
  // legend: only the kinds of bar that appear
  const present = new Set(runs.flatMap(({ r }) => r.timeline.map((t) => (r.config === 'chat' ? 'chat' : t.role))));
  const legend = [['chat', 'single session'], ['impl', 'implement (Hx)'], ['decompose', 'decompose'], ['review', 'review'], ['checkpoint', 'checkpoint']]
    .filter(([c]) => present.has(c))
    .map(([c, l], i, all) => { const lx = W - 20 - (all.length - i) * 130; return `<rect class="${c}" x="${lx}" y="${H - 22}" width="12" height="12" rx="2"/><text class="muted" x="${lx + 18}" y="${H - 12}" font-size="11">${l}</text>`; }).join('');
  writeFileSync(path.join(out, 'bench-timeline.svg'), svgDoc(W, H, A.css(), `
<text class="fg" x="20" y="34" font-size="20" font-weight="700">The same 6 issues, three ways</text>
<text class="muted" x="20" y="54" font-size="12">${esc(runs[0].r.model)} (${esc(runs[0].r.effort)} effort) · real runs replayed ${Math.round(maxMs / 1000 / 14)}× faster · bars = an agent on an issue</text>
${clocks.join('\n')}
${grid.join('\n')}
${parts.join('\n')}
${head}
${legend}`));
}

// ── flow: the Hx · 3 workers run replayed on its issue graph ──────────────────────────────────
{
  const run = runs.find((x) => x.id === 'hx3');
  if (run) {
    const r = run.r;
    const A = animator(r.wallMs);
    const W = 960;
    const blockers = issues.map((it) => {
      const sec = /## Blocked by\s*\n([\s\S]*)$/.exec(it.body)?.[1] ?? '';
      return /^\s*None\b/.test(sec) ? [] : [...sec.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    });
    const short = (t) => t.replace(/^Add (the )?/, '').replace(/\(.*\)/, '()');
    const depth = [];
    const d = (i) => (depth[i] ??= blockers[i].length ? 1 + Math.max(...blockers[i].map((b) => d(b - 1))) : 0);
    issues.forEach((_, i) => d(i));
    const session = (n) => r.timeline.find((t) => t.issue === n && t.role === 'impl');
    // node geometry: one column per dependency depth
    const nodeW = 196, nodeH = 52, colX = (c) => 40 + c * 300, top = 104;
    const byCol = {};
    const pos = issues.map((_, i) => { const c = depth[i]; byCol[c] = (byCol[c] ?? 0) + 1; return { x: colX(c), y: top + (byCol[c] - 1) * 74 }; });
    const parts = [];
    // edges: blocker → dependent
    issues.forEach((_, i) => blockers[i].forEach((b) => {
      const s = pos[b - 1], t = pos[i];
      const x1 = s.x + nodeW, y1 = s.y + nodeH / 2, x2 = t.x, y2 = t.y + nodeH / 2, mx = (x1 + x2) / 2;
      parts.push(`<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}"/><path d="M${x2 - 8},${y2 - 4} L${x2},${y2} L${x2 - 8},${y2 + 4}" class="edge"/>`);
    }));
    // nodes: blocked → ready → agent-working · W# → closed, at the recorded times
    issues.forEach((it, i) => {
      const n = i + 1, s = session(n), { x, y } = pos[i];
      if (!s) return;
      const readyAt = blockers[i].length ? Math.max(...blockers[i].map((b) => session(b)?.end ?? 0)) : 0;
      const states = [
        ['blocked', 0, readyAt, 'blocked', 'muted'],
        ['ready', readyAt, s.start, 'ready', 'muted'],
        ['working', s.start, s.end, `agent-working · W${s.lane + 1}`, 't-working'],
        ['closed', s.end, Infinity, 'closed ✓', 't-closed'],
      ].filter(([, a, b]) => b > a);
      for (const [k, a, b, label, tc] of states) {
        parts.push(`<g style="${A.during(a, b)};opacity:${b === Infinity ? 1 : 0}"><rect class="n-${k}" x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="8"/>`
          + `<text class="${tc}" x="${x + 12}" y="${y + 40}" font-size="11">${label}</text></g>`);
      }
      parts.push(`<text class="fg" x="${x + 12}" y="${y + 21}" font-size="13" font-weight="600">#${n} ${esc(short(it.title))}</text>`);
    });
    // workers: what each one is doing
    const lanes = Math.max(...r.timeline.map((t) => t.lane + 1));
    const wy = top + Math.max(...Object.values(byCol)) * 74 + 24;
    parts.push(`<rect class="panel" x="20" y="${wy}" width="${W - 40}" height="${30 + lanes * 34}" rx="8"/>`);
    parts.push(`<text class="muted" x="36" y="${wy + 22}" font-size="12">${lanes} parallel workers</text>`);
    for (let l = 0; l < lanes; l++) {
      const ly = wy + 46 + l * 34;
      parts.push(`<text class="fg" x="36" y="${ly}" font-size="13" font-weight="600">worker ${l + 1}</text>`);
      const mine = r.timeline.filter((t) => t.lane === l).sort((a, b) => a.start - b.start);
      let free = 0;
      for (const t of mine) {
        if (t.start > free) parts.push(`<text class="muted" style="${A.during(free, t.start)};opacity:0" x="140" y="${ly}" font-size="13">idle — nothing unblocked</text>`);
        parts.push(`<text class="t-working" style="${A.during(t.start, t.end)};opacity:0" x="140" y="${ly}" font-size="13">#${t.issue} ${esc(short(issues[t.issue - 1].title))} — fresh session: read issue → code + tests → ship</text>`);
        free = t.end;
      }
      parts.push(`<text class="muted" style="${A.during(free)}" x="140" y="${ly}" font-size="13">done</text>`);
    }
    const H = wy + 30 + lanes * 34 + 24;
    const clocks = [];
    for (let ms = 0; ms < r.wallMs; ms += 5000) clocks.push(`<text class="fg" style="${A.during(ms, ms + 5000)};opacity:0" x="${W - 20}" y="34" font-size="15" font-weight="600" text-anchor="end">t = ${clock(ms)}</text>`);
    clocks.push(`<text class="good" style="${A.during(r.wallMs)}" x="${W - 20}" y="34" font-size="15" font-weight="600" text-anchor="end">t = ${clock(r.wallMs)} · 6/6 closed, hidden tests ${r.hiddenPassed}/6</text>`);
    writeFileSync(path.join(out, 'hx-flow.svg'), svgDoc(W, H, A.css(), `
<text class="fg" x="20" y="34" font-size="20" font-weight="700">Hx: one board, three workers</text>
<text class="muted" x="20" y="54" font-size="12">the benchmark's Hx · 3 workers run, replayed from its log · an issue starts the moment its Blocked by closes</text>
<text class="muted" x="20" y="${top - 14}" font-size="12">GitHub issues — who blocks whom (label = state)</text>
${clocks.join('\n')}
${parts.join('\n')}`));
  }
}

// ── summary ───────────────────────────────────────────────────────────────────────────────────
{
  const metrics = [
    { name: 'Wall time', unit: (v) => mins(v), get: (r) => r.wallMs, lowerBetter: true },
    { name: 'Tokens', unit: (v) => mtok(v), get: (r) => r.tokens.total, lowerBetter: true },
    { name: 'Hidden tests passed', unit: (v) => `${v}/6`, get: (r) => r.hiddenPassed, max: 6 },
  ];
  // rows: each run, with its earlier measurement (bench/results/<phase>/) faded just above it
  const rows = [];
  for (const run of runs) {
    for (const phase of ['phase3']) {
      const f = path.join(here, 'results', phase, `${run.id}.json`);
      if (existsSync(f)) rows.push({ id: run.id, name: `${run.name} · before`, r: JSON.parse(readFileSync(f, 'utf8')), old: true });
    }
    rows.push(run);
  }
  const W = 960, colW = (W - 40) / metrics.length, barH = 22, gap = 10, top = 100;
  const H = top + rows.length * (barH + gap) + 50;
  const parts = [];
  metrics.forEach((m, mi) => {
    const x0 = 20 + mi * colW;
    const max = m.max ?? Math.max(...rows.map((x) => m.get(x.r)));
    parts.push(`<text class="fg" x="${x0 + 10}" y="${top - 14}" font-size="14" font-weight="600">${m.name}${m.lowerBetter ? ' <tspan class="muted" font-weight="400" font-size="11">(lower is better)</tspan>' : ''}</text>`);
    rows.forEach(({ id, name, r, old }, ri) => {
      const y = top + ri * (barH + gap);
      const v = m.get(r);
      const w = Math.max(2, (colW - 190) * (v / (max || 1)));
      parts.push(`<text class="muted" x="${x0 + 10}" y="${y + 15}" font-size="10.5">${esc(old ? 'before phase 4' : name)}</text>`);
      parts.push(`<rect class="${id === 'chat' ? 'chat' : 'impl'}"${old ? ' opacity="0.35"' : ''} x="${x0 + 100}" y="${y}" width="${w}" height="${barH}" rx="3"/>`);
      parts.push(`<text class="${old ? 'muted' : 'fg'}" x="${x0 + 106 + w}" y="${y + 15}" font-size="12" font-weight="600">${m.unit(v)}</text>`);
    });
  });
  writeFileSync(path.join(out, 'bench-summary.svg'), svgDoc(W, H, '', `
<text class="fg" x="20" y="34" font-size="20" font-weight="700">Benchmark summary</text>
<text class="muted" x="20" y="54" font-size="12">6 issues with dependencies · graded by hidden tests the agents never saw · ${esc(runs[0].r.model)} (${esc(runs[0].r.effort)})</text>
${parts.join('\n')}`));
}
console.log(`wrote ${path.relative(process.cwd(), out)}/: bench-timeline.svg, hx-flow.svg, bench-summary.svg from ${runs.map((x) => x.id).join(', ')}`);
