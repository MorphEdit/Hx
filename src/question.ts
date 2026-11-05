// needs-human: the owner's question on an issue and their answer to it (pure; PRD #286).

export const QUESTION_MARKER = '<!-- hx-question -->';

export interface ThreadComment { author: string; body: string; createdAt: string }
export interface FoundQuestion { text: string; createdAt: string }

const startsWith = (body: string, marker: string) => body.trimStart().startsWith(marker);
const time = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? -Infinity : t; };

/**
 * The open question: the latest comment starting with QUESTION_MARKER (the impl path), else the issue body
 * (the decompose path, created with the issue). `text` has the marker removed and is trimmed.
 */
export function findQuestion(body: string, comments: ThreadComment[], issueCreatedAt = ''): FoundQuestion {
  const q = comments.filter((c) => startsWith(c.body, QUESTION_MARKER)).pop();
  const raw = q ? q.body : body;
  return { text: raw.replace(QUESTION_MARKER, '').trim(), createdAt: q ? q.createdAt : issueCreatedAt };
}

/**
 * The owner's answer: the first comment by a trusted login (lowercased: the gh login + trustedAuthors), created
 * after the question, that is not one of hx's own `<!-- hx-` comments. A comment without an author never counts.
 */
export function findAnswer(question: FoundQuestion, comments: ThreadComment[], trusted: Set<string>): ThreadComment | null {
  const after = time(question.createdAt);
  return comments.find((c) => !!c.author && trusted.has(c.author.toLowerCase()) && !startsWith(c.body, '<!-- hx-')
    && time(c.createdAt) > after) ?? null;
}

/**
 * The question and its answer on an issue, or null while unanswered. Only trusted comments can be the question:
 * a stranger's marker comment neither moves the question nor reaches a prompt.
 */
export function ownerAnswer(t: { body: string; createdAt: string; comments: ThreadComment[] }, trusted: Set<string>): { question: string; answer: string } | null {
  const own = t.comments.filter((c) => !!c.author && trusted.has(c.author.toLowerCase()));
  const q = findQuestion(t.body, own, t.createdAt);
  const a = findAnswer(q, own, trusted);
  return a ? { question: q.text, answer: a.body.trim() } : null;
}

/** {{OWNER_ANSWER}} in the impl prompt: the question and the owner's answer verbatim, and what to do with them. */
export function ownerAnswerNote(qa: { question: string; answer: string } | null): string {
  if (!qa) return '';
  return `The owner answered a question on this issue. Carry out the choice they made, and quote their answer in the PR body under \`## Owner decisions\`.\n\nThe question:\n\n${qa.question}\n\nThe owner's answer:\n\n${qa.answer}\n`;
}
