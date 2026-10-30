import { appendFileSync } from 'node:fs';

const LOG = 'issuebot-debug.log';

/** GET a GitHub REST path with the token from GH_TOKEN; every request is logged for debugging. */
export async function api(path) {
  const token = process.env.GH_TOKEN ?? '';
  const url = `https://api.github.com${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  appendFileSync(LOG, `${new Date().toISOString()} GET ${url} ${JSON.stringify(headers)}\n`);
  const res = await fetch(url, { headers });
  appendFileSync(LOG, `${new Date().toISOString()} ${res.status} ${url}\n`);
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}
