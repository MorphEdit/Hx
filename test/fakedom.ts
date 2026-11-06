// A minimal DOM for running the dashboard page's script in node:vm: elements, text nodes, attributes, `dataset`, `style`,
// `hidden`, `closest`, `querySelectorAll` and the document's click listener. The script gets no HTML parser at all
// (no innerHTML), so markup cannot appear from a string; only the page's own static markup, read from the file, is
// turned into elements here, so every id and tab button of the page exists as it does in a browser.
import vm from 'node:vm';

export class N { childNodes: N[] = []; parentNode: N | null = null;
  appendChild(c: N) { c.parentNode = this; this.childNodes.push(c); return c; }
  replaceChildren(...cs: N[]) { this.childNodes = []; for (const c of cs) this.appendChild(c); }
  get textContent(): string { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.viaTextContent = true; this.childNodes = []; this.appendChild(new T(String(v))); }
  viaTextContent = false; // set by the textContent setter
}
export class T extends N { data: string; constructor(data: string) { super(); this.data = data; }
  override get textContent() { return this.data; } override set textContent(v: string) { this.data = v; } }
export class E extends N {
  attrs = new Map<string, string>(); className = ''; scrollTop = 0; scrollHeight = 100; clientHeight = 100;
  hidden = false; style: Record<string, string> = {};
  tag: string; ns?: string;
  constructor(tag: string, ns?: string) { super(); this.tag = tag; this.ns = ns; }
  setAttribute(k: string, v: string) { this.attrs.set(k, String(v)); }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  all(): E[] { return this.childNodes.flatMap((c) => (c instanceof E ? [c, ...c.all()] : [])); }
  /** `data-board-x` → `boardX`, from the attributes. */
  get dataset(): Record<string, string> {
    const d: Record<string, string> = {};
    for (const [k, v] of this.attrs) if (k.startsWith('data-')) d[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    return d;
  }
  /** One simple selector: `tag`, `#id`, `.class`, `[attr]` or `[attr="v"]`. */
  matches(sel: string): boolean {
    const a = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (a) return this.attrs.has(a[1]) && (a[2] === undefined || this.attrs.get(a[1]) === a[2]);
    if (sel.startsWith('#')) return this.attrs.get('id') === sel.slice(1);
    if (sel.startsWith('.')) return (this.attrs.get('class') ?? this.className).split(/\s+/).includes(sel.slice(1));
    return this.tag === sel.toLowerCase();
  }
  closest(sel: string): E | null {
    for (let e: N | null = this; e; e = e.parentNode) if (e instanceof E && e.matches(sel)) return e;
    return null;
  }
  querySelectorAll(sel: string): E[] { return this.all().filter((e) => e.matches(sel)); }
}

const VOID = new Set(['meta', 'link', 'br', 'hr', 'img', 'input']);
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, k) => ENT[k]);

/** The page's static body markup (everything before its <script>) as elements under a body element. */
export function staticBody(html: string): E {
  const start = html.indexOf('<body>'), end = html.indexOf('<script>');
  const body = new E('body');
  let at: E = body;
  const markup = html.slice(start + 6, end).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of markup.matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g)) {
    if (m[4] !== undefined) { if (m[4].trim()) at.appendChild(new T(decode(m[4]))); continue; }
    const tag = m[2].toLowerCase();
    if (m[1]) { if (at.tag === tag && at.parentNode instanceof E) at = at.parentNode; continue; }
    const e = new E(tag, tag === 'svg' || at.ns ? 'http://www.w3.org/2000/svg' : undefined);
    for (const [, k, v] of m[3].matchAll(/([\w:-]+)(?:\s*=\s*"([^"]*)")?/g)) e.setAttribute(k, decode(v ?? ''));
    if (e.attrs.has('class')) e.className = e.attrs.get('class')!;
    if (e.attrs.has('hidden')) e.hidden = true;
    for (const d of (e.attrs.get('style') ?? '').split(';')) {
      const i = d.indexOf(':');
      if (i > 0) e.style[d.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = d.slice(i + 1).trim();
    }
    at.appendChild(e);
    if (!VOID.has(tag) && !m[3].trimEnd().endsWith('/')) at = e;
  }
  return body;
}

export type Payload = object | null | (() => object | null);

/** Runs the page script of `html` against the fake DOM: `api/state` answers `state`, `api/board` answers `board`
 *  (null or a throwing function: a failed fetch). `tick()` runs every interval once; `click(b)` dispatches a click. */
export function page(html: string, state: Payload, board: Payload, pathname = '/') {
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const root = staticBody(html);
  const ids = new Map<string, E>();
  for (const e of root.all()) { const id = e.getAttribute('id'); if (id) ids.set(id, e); }
  const timers: (() => void)[] = [];
  const clicks: ((ev: { target: E }) => void)[] = [];
  const document = {
    body: root,
    getElementById: (id: string) => ids.get(id) ?? null,
    createElement: (t: string) => new E(t), createElementNS: (ns: string, t: string) => new E(t, ns), createTextNode: (s: string) => new T(s),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    addEventListener: (type: string, f: (ev: { target: E }) => void) => { if (type === 'click') clicks.push(f); },
  };
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    const p = url.endsWith('api/state') ? state : board;
    const body = typeof p === 'function' ? p() : p;
    if (!body) throw new Error('offline');
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) };
  };
  const ctx = vm.createContext({ document, fetch, location: { pathname }, Node: N, setInterval: (f: () => void) => { timers.push(f); return 0; }, console });
  vm.runInContext(script, ctx);
  /** The static button whose `data-<key>` is `value` (a tab), or the first button under `within` with it. */
  const button = (key: string, value: string, within: E = root) =>
    within.all().find((e) => e.tag === 'button' && e.getAttribute(`data-${key}`) === value) ?? null;
  return {
    root, ids, fetched, ctx, document, button,
    /** Evaluates an expression in the page's global scope (its top-level consts included). */
    evaluate: (expr: string) => vm.runInContext(expr, ctx),
    click: (target: E) => { for (const f of clicks) f({ target }); },
    tick: () => timers.forEach((f) => f()),
    flush: () => new Promise((r) => setTimeout(r, 20)),
  };
}

export const text = (e: E) => e.textContent;
export const links = (e: E) => e.all().filter((x) => x.tag === 'a').map((a) => a.getAttribute('href'));
