#!/usr/bin/env node
// Draws the README figures from bench/results/*.json (real runs, nothing hand-placed):
//   docs/figures/bench-timeline.svg — who worked on which issue, when, per configuration
//   docs/figures/bench-summary.svg  — wall time, tokens and hidden tests side by side
// SVGs follow the viewer's light/dark theme. Run: node bench/figures.mjs
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const mins = (ms) => `${(ms / 60000).toFixed(1)} min`;
const mtok = (n) => `${(n / 1e6).toFixed(2)}M`;
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;
const STYLE = `<style>
  :root { --bg:#ffffff; --panel:#f6f8fa; --border:#d0d7de; --fg:#1f2328; --muted:#656d76; --track:#eaeef2;
          --impl:#2f81f7; --decompose:#8250df; --review:#bf8700; --checkpoint:#cf222e; --chat:#57606a; --good:#1a7f37; --bad:#cf222e; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e; --track:#21262d;
            --impl:#4493f8; --decompose:#a371f7; --review:#d29922; --checkpoint:#f85149; --chat:#8b949e; --good:#3fb950; --bad:#f85149; }
  }
  .bg { fill: var(--bg); } .panel { fill: var(--panel); stroke: var(--border); }
  .fg { fill: var(--fg); } .muted { fill: var(--muted); } .track { fill: var(--track); }
  .grid { stroke: var(--border); stroke-dasharray: 2 3; } .end { stroke: var(--fg); stroke-dasharray: 3 3; opacity: .6; }
  .good { fill: var(--good); } .bad { fill: var(--bad); }
  .impl { fill: var(--impl); } .decompose { fill: var(--decompose); } .review { fill: var(--review); }
  .checkpoint { fill: var(--checkpoint); } .chat { fill: var(--chat); }
  .label { fill: #ffffff; font-weight: 600; }
</style>`;

// ── timeline ──────────────────────────────────────────────────────────────────────────────────
{
  const W = 960, left = 150, right = 210, plotW = W - left - right, laneH = 26, laneGap = 8;
  const maxMs = Math.max(...runs.map((x) => x.r.wallMs));
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
      parts.push(`<rect class="${cls}" x="${x(t.start) + 1}" y="${ly + 2}" width="${bw}" height="${laneH - 4}" rx="3"><title>#${t.issue} ${t.role}: ${mins(t.end - t.start)}</title></rect>`);
      if (bw > 17) parts.push(`<text class="label" x="${x(t.start) + 1 + bw / 2}" y="${ly + 17}" font-size="11" text-anchor="middle">#${t.issue}</text>`);
    }
    parts.push(`<line class="end" x1="${x(r.wallMs)}" x2="${x(r.wallMs)}" y1="${y + 34}" y2="${y + h - 8}"/>`);
    const sx = W - right + 20;
    parts.push(`<text class="fg" x="${sx}" y="${y + 50}" font-size="14" font-weight="600">${mins(r.wallMs)}</text>`);
    parts.push(`<text class="muted" x="${sx}" y="${y + 68}" font-size="12">${mtok(r.tokens.total)} tokens</text>`);
    parts.push(`<text class="${r.hiddenPassed === 6 ? 'good' : 'bad'}" x="${sx}" y="${y + 86}" font-size="12">hidden tests ${r.hiddenPassed}/6</text>`);
    y += h + 14;
  }
  const axisY = y;
  const grid = [];
  for (let i = 0; i <= ticks; i++) {
    grid.push(`<line class="grid" x1="${x(i * step * 60000)}" x2="${x(i * step * 60000)}" y1="62" y2="${axisY - 10}"/>`);
    grid.push(`<text class="muted" x="${x(i * step * 60000)}" y="${axisY + 6}" font-size="11" text-anchor="middle">${i * step}m</text>`);
  }
  const H = axisY + 40;
  // legend: only the kinds of bar that appear
  const present = new Set(runs.flatMap(({ r }) => r.timeline.map((t) => (r.config === 'chat' ? 'chat' : t.role))));
  const legend = [['chat', 'single session'], ['impl', 'implement (Hx)'], ['decompose', 'decompose'], ['review', 'review'], ['checkpoint', 'checkpoint']]
    .filter(([c]) => present.has(c))
    .map(([c, l], i, all) => { const lx = W - 20 - (all.length - i) * 130; return `<rect class="${c}" x="${lx}" y="${H - 22}" width="12" height="12" rx="2"/><text class="muted" x="${lx + 18}" y="${H - 12}" font-size="11">${l}</text>`; }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>
${STYLE}
<rect class="bg" width="${W}" height="${H}" rx="10"/>
<text class="fg" x="20" y="34" font-size="20" font-weight="700">The same 6 issues, three ways</text>
<text class="muted" x="20" y="54" font-size="12">${esc(runs[0].r.model)} (${esc(runs[0].r.effort)} effort) · real runs · bars = time an agent spent on an issue · dashed line = all done</text>
${grid.join('\n')}
${parts.join('\n')}
${legend}
</svg>
`;
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'bench-timeline.svg'), svg);
}

// ── summary ───────────────────────────────────────────────────────────────────────────────────
{
  const metrics = [
    { name: 'Wall time', unit: (v) => mins(v), get: (r) => r.wallMs, lowerBetter: true },
    { name: 'Tokens', unit: (v) => mtok(v), get: (r) => r.tokens.total, lowerBetter: true },
    { name: 'Hidden tests passed', unit: (v) => `${v}/6`, get: (r) => r.hiddenPassed, max: 6 },
  ];
  const W = 960, colW = (W - 40) / metrics.length, barH = 24, gap = 12, top = 100;
  const H = top + runs.length * (barH + gap) + 60;
  const parts = [];
  metrics.forEach((m, mi) => {
    const x0 = 20 + mi * colW;
    const max = m.max ?? Math.max(...runs.map((x) => m.get(x.r)));
    parts.push(`<text class="fg" x="${x0 + 10}" y="${top - 14}" font-size="14" font-weight="600">${m.name}${m.lowerBetter ? ' <tspan class="muted" font-weight="400" font-size="11">(lower is better)</tspan>' : ''}</text>`);
    runs.forEach(({ id, name, r }, ri) => {
      const y = top + ri * (barH + gap);
      const v = m.get(r);
      const w = Math.max(2, (colW - 175) * (v / (max || 1)));
      parts.push(`<text class="muted" x="${x0 + 10}" y="${y + 16}" font-size="11">${esc(name)}</text>`);
      parts.push(`<rect class="${id === 'chat' ? 'chat' : 'impl'}" x="${x0 + 100}" y="${y}" width="${w}" height="${barH}" rx="3"/>`);
      parts.push(`<text class="fg" x="${x0 + 106 + w}" y="${y + 16}" font-size="12" font-weight="600">${m.unit(v)}</text>`);
    });
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" ${FONT}>
${STYLE}
<rect class="bg" width="${W}" height="${H}" rx="10"/>
<text class="fg" x="20" y="34" font-size="20" font-weight="700">Benchmark summary</text>
<text class="muted" x="20" y="54" font-size="12">6 issues with dependencies · graded by hidden tests the agents never saw · ${esc(runs[0].r.model)} (${esc(runs[0].r.effort)})</text>
${parts.join('\n')}
</svg>
`;
  writeFileSync(path.join(out, 'bench-summary.svg'), svg);
}
console.log(`wrote ${path.relative(process.cwd(), out)}/bench-timeline.svg and bench-summary.svg from ${runs.map((x) => x.id).join(', ')}`);
