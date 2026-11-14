// A PRD's `## Original request` (PRD #475): the user's own words kept word for word, the helpers in src/prd.ts and the
// rule in every prompt that reads a PRD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keepOriginal, originalRequest, quoteIdea, withIdea } from '../src/prd.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name: string) => readFileSync(path.join(here, '..', 'prompts', `${name}.md`), 'utf8').replace(/\s+/g, ' ');

test('originalRequest: the first section, heading to the next "## " line; quoted "## " lines stay inside; none → null', () => {
  assert.equal(originalRequest('## Goals\nx\n'), null);
  assert.equal(originalRequest(''), null);
  const body = '## Original request\n\n> idea\n> ## a heading of the idea\n\n## Goals\nx\n\n## Original request\n\n> second\n';
  assert.equal(originalRequest(body), '## Original request\n\n> idea\n> ## a heading of the idea\n\n');
  assert.equal(originalRequest('# T\n\n## Original request\n> last'), '## Original request\n> last');
});

test('quoteIdea: each line prefixed "> ", blank lines at the start and end dropped, CRLF read as LF', () => {
  assert.equal(quoteIdea('\n\nadd dark mode\n\nand a toggle\n\n'), '> add dark mode\n> \n> and a toggle');
  assert.equal(quoteIdea('a\r\nb\r\n'), '> a\n> b');
});

test('withIdea: no section → one added first, right after the title, holding the idea as a block quote', () => {
  assert.equal(withIdea('# Dark mode\n\n## Goals\nShip it.\n', 'add dark mode'),
    '# Dark mode\n\n## Original request\n\n> add dark mode\n\n## Goals\nShip it.\n');
  // no "## " line at all: at the end of the file
  assert.equal(withIdea('# Dark mode\n\nShip it.\n', 'add dark mode'), '# Dark mode\n\nShip it.\n\n## Original request\n\n> add dark mode\n');
});

test('withIdea: a section without the idea → the idea at its top, the session\'s lines below', () => {
  const body = '# T\n\n## Original request\n\n> only dark, no toggle\n\n## Goals\nx\n';
  assert.equal(withIdea(body, 'add dark mode\nwith a toggle'),
    '# T\n\n## Original request\n\n> add dark mode\n> with a toggle\n\n> only dark, no toggle\n\n## Goals\nx\n');
  // an empty section
  assert.equal(withIdea('# T\n\n## Original request\n\n## Goals\nx\n', 'idea'), '# T\n\n## Original request\n\n> idea\n\n## Goals\nx\n');
});

test('withIdea: a section that holds the idea (> prefixes, whitespace and CRLF aside) → unchanged', () => {
  const body = '# T\n\n## Original request\n\n> add dark mode\n> with   a toggle\n\n> no, only dark\n\n## Goals\nx\n';
  assert.equal(withIdea(body, 'add dark mode with a toggle'), body);
  assert.equal(withIdea(body, '\r\nadd dark mode\r\nwith a toggle\r\n'), body);
  const crlf = body.replace(/\n/g, '\r\n');
  assert.equal(withIdea(crlf, 'add dark mode\nwith a toggle'), crlf);
  // an idea with headings of its own: quoted, so they stay in the section, and a second run finds it there
  const once = withIdea('# T\n\n## Goals\nx\n', 'Build it.\n\n## Scope\nall of it');
  assert.equal(originalRequest(once), '## Original request\n\n> Build it.\n> \n> ## Scope\n> all of it\n\n');
  assert.equal(withIdea(once, 'Build it.\n\n## Scope\nall of it'), once);
});

test('withIdea: an empty or whitespace-only idea → the body as written', () => {
  const body = '# T\n\n## Goals\nx\n';
  for (const idea of ['', '  \n\t\n']) assert.equal(withIdea(body, idea), body);
});

test('withIdea: a long idea (20 KB) is kept whole', () => {
  const idea = Array.from({ length: 500 }, (_, i) => `line ${i} of a long idea, kept word for word`).join('\n');
  assert.ok(idea.length > 20_000);
  const out = withIdea('# T\n\n## Goals\nx\n', idea);
  assert.ok(originalRequest(out)!.includes(quoteIdea(idea)));
});

test('withIdea: a CRLF PRD gets CRLF lines', () => {
  assert.equal(withIdea('# T\r\n\r\n## Goals\r\nx\r\n', 'a\nb'), '# T\r\n\r\n## Original request\r\n\r\n> a\r\n> b\r\n\r\n## Goals\r\nx\r\n');
});

const SECTION = '## Original request\n\n> make search fast\n\n';

test('keepOriginal: the same section, or none before and after → the body as it is, no line', () => {
  const after = `${SECTION}## Goals\nrevised\n`;
  assert.deepEqual(keepOriginal(`${SECTION}## Goals\nold\n`, after), { body: after, line: null });
  // line endings and blank lines at the end of the section aside
  const crlf = `## Original request\r\n\r\n> make search fast\r\n\r\n\r\n## Goals\r\nrevised\r\n`;
  assert.deepEqual(keepOriginal(`${SECTION}## Goals\nold\n`, crlf), { body: crlf, line: null });
  assert.deepEqual(keepOriginal('## Goals\nold\n', '## Goals\nnew\n'), { body: '## Goals\nnew\n', line: null });
});

test('keepOriginal: a changed section → the earlier text where it stands, the rest of the reviser\'s body kept', () => {
  const r = keepOriginal(`${SECTION}## Goals\nold\n`, '## Goals\nnew\n\n## Original request\n\n> make it fast\n\n## Assumptions\n- a\n');
  assert.equal(r.body, `## Goals\nnew\n\n${SECTION}## Assumptions\n- a\n`);
  assert.equal(r.line, 'the reviser changed the ## Original request section — the earlier text put back');
  // the changed section was the last one
  assert.equal(keepOriginal(`${SECTION}## Goals\nold\n`, '## Goals\nnew\n\n## Original request\n> other').body, `## Goals\nnew\n\n${SECTION.trimEnd()}\n`);
});

test('keepOriginal: a removed section → the earlier text as the first section', () => {
  const r = keepOriginal(`${SECTION}## Goals\nold\n`, '## Goals\nnew\n');
  assert.equal(r.body, `${SECTION}## Goals\nnew\n`);
  assert.equal(r.line, 'the reviser removed the ## Original request section — the earlier text put back as the first section');
});

test('keepOriginal: a section added to a PRD that had none → every one removed', () => {
  const r = keepOriginal('## Goals\nold\n', `${SECTION}## Goals\nnew\n\n## Original request\n> again\n\n## Notes\nn\n`);
  assert.equal(r.body, '## Goals\nnew\n\n## Notes\nn\n');
  assert.equal(r.line, 'the reviser added a ## Original request section the PRD did not have — removed');
});

test('keepOriginal: two sections before — the first counts', () => {
  const before = `${SECTION}## Goals\nx\n\n## Original request\n\n> second\n`;
  assert.equal(keepOriginal(before, `${SECTION}## Goals\ny\n`).line, null);
});

// the rule in every role that reads a PRD (PRD #475, Behaviour 6)
const RULE_ROLES = ['impl', 'audit', 'review', 'decompose', 'critic'];

test('the precedence rule: every role that reads a PRD carries it, with "a later line outranks an earlier one"', () => {
  for (const role of RULE_ROLES) {
    const p = prompt(role);
    assert.ok(p.includes("The PRD's `## Original request` section, when it has one, is the user's own words: it outranks the rest of the PRD, which outranks the issue"), `${role}: the precedence`);
    assert.ok(p.includes('inside the section a later line outranks an earlier one'), `${role}: a later line outranks an earlier one`);
    assert.ok(p.includes('Where they conflict, follow the original request and say so'), `${role}: follow it and say so`);
  }
  assert.match(prompt('impl'), /what you followed in the PR body under `## Decisions made for you`/);
  assert.match(prompt('audit'), /A PR that follows the issue against the original request is a finding/);
  assert.match(prompt('review'), /A merged result that misses the original request is a gap/);
  assert.match(prompt('decompose'), /cut the issues from the PRD and check each against the original request/);
  assert.match(prompt('critic'), /A PRD statement that contradicts the original request is a finding/);
});

test('revise.md: keep the section exactly, add none', () => {
  assert.match(prompt('revise'), /keep the PRD's `## Original request` section exactly as it is \(the user's own words\), and add none when the PRD has none/);
});

test('the PRD shape in grill.md and the skill lists ## Original request first, word for word, block quote, idea then answers', () => {
  const skill = readFileSync(path.join(here, '..', 'templates', 'hx-skill.md'), 'utf8');
  for (const [name, text] of [['grill', readFileSync(path.join(here, '..', 'prompts', 'grill.md'), 'utf8')], ['skill', skill]]) {
    assert.match(text, /# <title>\r?\n\s*## Original request\r?\n\s*## Goals/, `${name}: first section`);
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /`## Original request` is the user's own words, word for word, as a block quote \(every line starts with `> `\)/, name);
    assert.match(flat, /then each answer of (the user's|theirs) that changed or added scope, quoted as (they|it) wrote it, in the order they gave them/, name);
    assert.match(flat, /No paraphrase and no summary\. A later line outranks an earlier one\./, name);
  }
  assert.match(readFileSync(path.join(here, '..', 'prompts', 'grill.md'), 'utf8').replace(/\s+/g, ' '), /first the idea above, then/);
});

test('docs: the guide\'s PRD flow describes the section, the precedence and both engine checks; design notes the idea\'s source', () => {
  const read = (f: string) => readFileSync(path.join(here, '..', f), 'utf8').replace(/\s+/g, ' ');
  const guide = read('docs/guide.md');
  const flow = guide.slice(guide.indexOf('## PRD flow'), guide.indexOf('### One child for a small PRD'));
  assert.match(flow, /`## Original request` section, right after the title, holding the user's own words as a block quote/);
  assert.match(flow, /the original request outranks the rest of the PRD, which outranks an issue, and inside the section a later line outranks an earlier one/);
  assert.match(flow, /\*\*hx grill\*\*: .*No section: hx adds one, first, holding the idea; a section without the idea: hx puts the idea at its top/);
  assert.match(flow, /\*\*After every revise session\*\* .*a changed section is put back where it stands, a removed one as the first section, and one the reviser added to a PRD that had none is removed/);
  const design = read('docs/design.md');
  assert.match(design, /## Original request \(PRD #475\) The idea is Harness's `## Original request` \(VocanicZ\/Harness/);
});
