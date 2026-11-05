// The user docs as one text: the short README, the guide and the benchmarks page. Tests that check a
// behaviour is documented read this, so a section can live in whichever file suits a reader.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DOC_FILES = ['README.md', 'docs/guide.md', 'docs/benchmark.md'];
export const docsText = () => DOC_FILES.map((f) => readFileSync(path.join(root, f), 'utf8')).join('\n');
