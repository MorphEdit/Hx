// needs-human: the owner's question on an issue and their answer to it (pure; PRD #286).

export const QUESTION_MARKER = '<!-- hx-question -->';
/** After a decompose session past maxOpenQuestions: the `[needs you]` child goes back to ready-for-agent (capQuestions). */
export const TOO_MANY_QUESTIONS = '**hx:** too many open questions; the agent takes the recommended choice';
/** On an impl NEEDS_HUMAN stop at the cap: no question is posted, the issue goes back to ready-for-agent. */
export const IMPL_TOO_MANY_QUESTIONS = '**hx:** too many open questions; the next session takes the recommended choice';

export interface ThreadComment { author: string; body: string; createdAt: string }
export interface FoundQuestion { text: string; createdAt: string }

const startsWith = (body: string, marker: string) => body.trimStart().startsWith(marker);
/** hx's own comments: a `<!-- hx-…` marker or a `**hx:**` line first. Never the owner's answer (#332). */
const HX_PREFIXES = ['<!-- hx-', '**hx:**'];
const isHxComment = (body: string) => HX_PREFIXES.some((m) => startsWith(body, m));
const isCapComment = (body: string) => [TOO_MANY_QUESTIONS, IMPL_TOO_MANY_QUESTIONS].includes(body.trim());
const time = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? -Infinity : t; };

/**
 * The open question: the latest comment starting with QUESTION_MARKER (the impl path), else the issue body when it
 * starts with QUESTION_MARKER (the decompose path, created with the issue), else null: a plain issue has no question.
 * `text` has the marker removed and is trimmed.
 */
export function findQuestion(body: string, comments: ThreadComment[], issueCreatedAt = ''): FoundQuestion | null {
  const q = comments.filter((c) => startsWith(c.body, QUESTION_MARKER)).pop();
  if (!q && !startsWith(body, QUESTION_MARKER)) return null;
  const raw = q ? q.body : body;
  return { text: raw.replace(QUESTION_MARKER, '').trim(), createdAt: q ? q.createdAt : issueCreatedAt };
}

/**
 * The owner's answer: the first comment by a trusted login (lowercased: the gh login + trustedAuthors), created
 * after the question, that is not one of hx's own comments (`<!-- hx-…` or `**hx:**` first, the cap comments among
 * them). A comment without an author never counts.
 */
export function findAnswer(question: FoundQuestion, comments: ThreadComment[], trusted: Set<string>): ThreadComment | null {
  const after = time(question.createdAt);
  return comments.find((c) => !!c.author && trusted.has(c.author.toLowerCase()) && !isHxComment(c.body)
    && time(c.createdAt) > after) ?? null;
}

/**
 * The question and its answer on an issue, or null while unanswered. Only trusted comments can be the question:
 * a stranger's marker comment neither moves the question nor reaches a prompt.
 */
export function ownerAnswer(t: { body: string; createdAt: string; comments: ThreadComment[] }, trusted: Set<string>): { question: string; answer: string } | null {
  const own = t.comments.filter((c) => !!c.author && trusted.has(c.author.toLowerCase()));
  const q = findQuestion(t.body, own, t.createdAt);
  if (!q) return null;
  const a = findAnswer(q, own, trusted);
  return a ? { question: q.text, answer: a.body.trim() } : null;
}

/**
 * The question on an issue hx put back to ready-for-agent at the cap (a cap comment after it) and that the owner has
 * not answered, or null. Like ownerAnswer, only trusted comments count.
 */
export function cappedQuestion(t: { body: string; createdAt: string; comments: ThreadComment[] }, trusted: Set<string>): string | null {
  const own = t.comments.filter((c) => !!c.author && trusted.has(c.author.toLowerCase()));
  const q = findQuestion(t.body, own, t.createdAt);
  if (!q || findAnswer(q, own, trusted)) return null;
  const after = time(q.createdAt);
  return own.some((c) => isCapComment(c.body) && time(c.createdAt) >= after) ? q.text : null;
}

/** {{OWNER_ANSWER}} for a capped question: the owner was not asked; take the recommended choice and say so. */
export function cappedQuestionNote(question: string | null): string {
  if (question === null) return '';
  return `The owner was not asked this issue's question: too many questions were open. Take the recommended choice yourself and note it in the PR body under \`## Decisions made for you\`.

The question:

${question}
`;
}

/** {{OWNER_ANSWER}} in the impl prompt: the question and the owner's answer verbatim, and what to do with them. */
export function ownerAnswerNote(qa: { question: string; answer: string } | null): string {
  if (!qa) return '';
  return `The owner answered a question on this issue. Carry out the choice they made, and quote their answer in the PR body under \`## Owner decisions\`.\n\nThe question:\n\n${qa.question}\n\nThe owner's answer:\n\n${qa.answer}\n`;
}

/**
 * The question comment an impl session that stopped with its NEEDS_HUMAN promise asks: its final message with every
 * line holding that promise (`promiseRe`, PROMISE_RE of state.ts) removed, trimmed, with QUESTION_MARKER put first
 * when it does not start with it.
 */
export function questionFromReply(text: string, promiseRe: RegExp): string {
  const re = new RegExp(`^.*${promiseRe.source}.*$`, 'gm');
  const q = text.replace(re, '').trim();
  return startsWith(q, QUESTION_MARKER) ? q : `${QUESTION_MARKER}\n${q}`;
}
