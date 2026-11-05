// The node:test reporter bench/project-grade.mjs runs the hidden suite with: one JSON line per case,
// { name: "<file> > <test>", ok }. Suites are not cases; a file that fails outside any test is one failed case.
import path from 'node:path';

export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite') continue;
    const file = data.file ? path.basename(data.file) : '?';
    const name = data.name === data.file || !data.file ? file : `${file} > ${data.name}`;
    yield JSON.stringify({ name, ok: type === 'test:pass' }) + '\n';
  }
}
