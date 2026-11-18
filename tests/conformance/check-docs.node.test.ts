// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-docs.ts', import.meta.url));
const sections = ['Purpose', 'Entry points', 'Do', 'Never', 'Limits', 'Tests'];
const agents = sections.map((section) => `## ${section}\n\nText.\n`).join('\n');
const index = '# Fixture\n\n> Offline docs.\n\n## Docs\n\n- [Readme](README.md): start here.\n';

function fixture(extra: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'galaxie-docs-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'README.md': '# Hello, `World`!\n\n## Same\n\n## Same\n\n## Same-1\n\n## Same\n',
    'packages/demo/package.json': '{}',
    'packages/demo/README.md': '# Demo\n',
    'packages/demo/AGENTS.md': agents,
    'llms.txt': index,
    'packages/core/src/tracing.ts': `const ALLOWED = new Set(['galaxie.fixture']);
const text = (span: Span, key: 'gen_ai.input.messages', value: unknown): void => {};
`,
    'docs/guides/tracing.md': `# Tracing

| Span or outcome | Emitted attributes |
| --- | --- |
| Fixture | \`galaxie.fixture\`, \`gen_ai.input.messages\` |
`,
    ...extra,
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['add', '--', ...Object.keys(files)], { cwd: root });
  return root;
}

function run(root: string, ...args: string[]): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
  return { status: result.status, output: result.stdout + result.stderr };
}

test('checks local links, images, references, encoded paths and duplicate GitHub slugs', () => {
  const root = fixture({
    'guide.md': [
      '# Guide',
      '[Heading](README.md#hello-world)',
      '[Second](README.md#same-1)',
      '[Collision](README.md#same-1-1)',
      '[Third](README.md#same-2)',
      '[Local](#guide)',
      '![Image](assets/a%20b.svg)',
      '[Reference][readme]',
      '[readme]: README.md "Title"',
      '[Shortcut]',
      '[shortcut]: <assets/a b.svg>',
      '[Nested](assets/a(b).svg "Title")',
      '[Query](README.md?raw=1#same)',
      '[External](https://example.invalid/no-fetch)',
      '[Email](mailto:test@example.invalid)',
      '`[Ignored](missing.md)`',
      '``[Ignored ` code](missing.md)``',
      '```md',
      '[Ignored](missing.md)',
      '```',
      '~~~md',
      '[Ignored](missing.md)',
      '~~~',
    ].join('\n'),
    'assets/a b.svg': '<svg/>',
    'assets/a(b).svg': '<svg/>',
    'docs/plans/plan.md': '[Excluded](missing.md)',
    'internal/private.md': '[Excluded](missing.md)',
    'node_modules/demo/README.md': '[Excluded](missing.md)',
  });
  // Untracked files are outside this check's contract.
  writeFileSync(join(root, 'untracked.md'), '[Ignored](missing.md)');
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each([
  ['[Missing](absent.md)', 'missing target: absent.md'],
  ['![Missing](absent.png)', 'missing target: absent.png'],
  ['[Missing](README.md#absent)', 'missing heading: README.md#absent'],
  ['[Missing](#absent)', 'missing heading: #absent'],
  ['[Missing][ref]\n\n[ref]: absent.md', 'missing target: absent.md'],
])('reports a file and line for %s', (link, message) => {
  const result = run(fixture({ 'guide.md': `# Guide\n\n${link}\n` }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`guide.md:3: ${message}`);
});

test('checks source line fragments including encoded fragments and ranges', () => {
  const root = fixture({
    'guide.md':
      '[First](source.ts#L1) [Last](source.ts#L2) [Range](source.ts#L1-L2) [Encoded](source.ts#%4C2)\n',
    'source.ts': 'first\nlast\n',
  });
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each(['L0', 'L3', 'L2-L1', 'L1-L3', 'L1-L', 'L1.5'])(
  'rejects an invalid source line fragment: %s',
  (fragment) => {
    const result = run(
      fixture({
        'guide.md': `[Source](source.ts#${fragment})\n`,
        'source.ts': 'first\nlast\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain(`guide.md:1: invalid source lines: source.ts#${fragment}`);
  },
);

test.each(['AGENTS.md', 'README.md'])('requires each package %s', (name) => {
  const root = fixture();
  rmSync(join(root, 'packages/demo', name));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`packages/demo/${name}:1: missing required file`);
});

test.each(sections)('requires the package %s section', (section) => {
  const result = run(fixture({ 'packages/demo/AGENTS.md': agents.replace(`## ${section}\n`, '') }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`packages/demo/AGENTS.md:1: missing section: ${section}`);
});

test.each([
  [index.replace('# Fixture\n', ''), 'missing H1'],
  [index.replace('> Offline docs.\n', ''), 'missing blockquote summary'],
  [index.replace('## Docs\n', ''), 'missing H2 section'],
  [index.replace('README.md', 'absent.md'), 'missing target: absent.md'],
])('validates the llms.txt structure and targets', (content, message) => {
  const result = run(fixture({ 'llms.txt': content }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(message);
});

test('requires llms.txt', () => {
  const root = fixture();
  rmSync(join(root, 'llms.txt'));
  expect(run(root)).toEqual({
    status: 1,
    output: 'llms.txt:1: missing required file\n',
  });
});

test('passes on the tracked repository documentation', () => {
  expect(run(fileURLToPath(new URL('../..', import.meta.url)))).toEqual({
    status: 0,
    output: '',
  });
});

test('the Next.js reference absolute repository links resolve, including heading anchors', () => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  const prefix = 'https://github.com/vinhnxv/galaxie/blob/main/';
  const source = readFileSync(join(repo, 'skills/galaxie/references/nextjs.md'), 'utf8');
  const targets = [...source.matchAll(/\]\((https:\/\/[^\s)]+)\)/g)].map((match) => {
    const url = match[1]!;
    expect(url).toMatch(/^https:\/\/github\.com\/vinhnxv\/galaxie\/blob\/main\//);
    return url.slice(prefix.length);
  });
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.some((target) => target.startsWith('docs/guides/nextjs.md#'))).toBe(true);
  const linksOnly = source.replaceAll(prefix, '').replace(/^<!-- galaxie:cite .+ -->$/gm, '');
  const root = fixture({ 'reference.md': linksOnly });
  for (const target of targets) {
    const path = target.split('#')[0]!;
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    // Untracked targets are read for anchors, without scanning their outgoing links.
    writeFileSync(destination, readFileSync(join(repo, path)));
  }
  expect(run(root)).toEqual({ status: 0, output: '' });
  const anchored = targets.find((target) => target.includes('#'))!;
  writeFileSync(
    join(root, 'reference.md'),
    linksOnly.replace(anchored, `${anchored}-missing-heading`),
  );
  const broken = run(root);
  expect(broken.status).toBe(1);
  expect(broken.output).toContain(`missing heading: ${anchored}-missing-heading`);
});

test.each([
  '[API [v1]](absent.md)',
  '[API](\nabsent.md\n)',
  '[![Icon](assets/icon.svg)](absent.md)',
])('rejects a broken target in a wrapped link: %s', (link) => {
  const result = run(fixture({ 'guide.md': `# Guide\n\n${link}\n`, 'assets/icon.svg': '<svg/>' }));
  expect(result.status).toBe(1);
  expect(result.output).toContain('guide.md:3: missing target: absent.md');
});

test('ignores links and reference definitions inside multiline inline code', () => {
  const root = fixture({
    'guide.md': '# Guide\n\n`example\n[Ignored](absent.md)\n[ref]: absent.md\n`\n',
  });
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test('validates same-file llms.txt fragments', () => {
  const result = run(fixture({ 'llms.txt': `${index}\n[Missing](#absent)\n` }));
  expect(result.status).toBe(1);
  expect(result.output).toContain('missing heading: #absent');
});

test('accepts an existing same-file llms.txt fragment', () => {
  expect(run(fixture({ 'llms.txt': `${index}\n[Section](#docs)\n` }))).toEqual({
    status: 0,
    output: '',
  });
});

test.each([
  ['absent.md', 'README.md', 1],
  ['README.md', 'absent.md', 0],
])('uses the first reference definition: %s before %s', (first, second, status) => {
  const result = run(
    fixture({ 'guide.md': `# Guide\n\n[API][ref]\n\n[ref]: ${first}\n[REF]: ${second}\n` }),
  );
  expect(result.status).toBe(status);
  if (status === 1) expect(result.output).toContain('guide.md:3: missing target: absent.md');
  else expect(result.output).toBe('');
});

const citationFile = 'skills/galaxie/references/rules.md';
const sectionBody = '- Keep checks.\n\n### Detail\n\nKeep this too.';
const sectionHash = createHash('sha256').update(sectionBody).digest('hex');
const citedSource = `---\nlabel: fixture\n---\n\n# Rules\n\n## Never\n\n${sectionBody}\n\n## Other\n\nNot cited.\n`;
const citation = `<!-- galaxie:cite path="rules.md" heading="Never" sha256="${sectionHash}" -->`;

function citationFixture(source = citedSource, comment = citation): string {
  return fixture({
    'rules.md': source,
    [citationFile]: `# Guidance\n\n${comment}\nKeep checks.\n`,
  });
}

test('accepts a section citation and never writes during a normal check', () => {
  const root = citationFixture();
  const before = readFileSync(join(root, citationFile));
  expect(run(root)).toEqual({ status: 0, output: '' });
  expect(readFileSync(join(root, citationFile))).toEqual(before);
});

test.each([
  ['removed', citedSource.replace('## Never', '## Renamed'), 'missing heading: rules.md#Never'],
  [
    'duplicated',
    `${citedSource}\n## Never\n\nAnother rule.\n`,
    'ambiguous heading: rules.md#Never',
  ],
])('rejects a %s cited heading', (_name, source, message) => {
  const result = run(citationFixture(source));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:3: ${message}`);
});

test('rejects a missing citation file', () => {
  const root = citationFixture();
  rmSync(join(root, 'rules.md'));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:3: missing citation file: rules.md`);
});

test('detects an added rule, refreshes only hashes and passes on the next check', () => {
  const root = citationFixture(citedSource.replace('## Other', '- Another rule.\n\n## Other'));
  const before = readFileSync(join(root, citationFile), 'utf8');
  const failed = run(root);
  expect(failed.status).toBe(1);
  expect(failed.output).toContain(`${citationFile}:3: citation hash mismatch: rules.md#Never`);
  expect(failed.output).toContain('node scripts/check-docs.ts --refresh-citations');
  expect(readFileSync(join(root, citationFile), 'utf8')).toBe(before);
  expect(run(root, '--refresh-citations')).toEqual({ status: 0, output: '' });
  const refreshed = readFileSync(join(root, citationFile), 'utf8');
  const expected = createHash('sha256').update(`${sectionBody}\n\n- Another rule.`).digest('hex');
  expect(refreshed).toBe(before.replace(sectionHash, expected));
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test('normalizes CRLF, trailing whitespace and surrounding blank lines, not internal blanks', () => {
  const source = citedSource
    .replace(sectionBody, `\n${sectionBody}\n\n`)
    .split('\n')
    .map((line) => `${line} \t`)
    .join('\r\n');
  const root = citationFixture(source);
  expect(run(root)).toEqual({ status: 0, output: '' });
  writeFileSync(join(root, 'rules.md'), source.replace('### Detail', '\r\n### Detail'));
  expect(run(root).output).toContain('citation hash mismatch');
});

test('hashes raw fenced samples and ignores fenced headings and setext underlines for extents', () => {
  const body = '- Keep checks.\n\n```md\n## Never\nFake title\n---\n```\n\nLast rule.';
  const hash = createHash('sha256').update(body).digest('hex');
  const source = `---\nNever\n---\n\n# Rules\n\n## Never\n\n${body}\n\n## Other\nEnd.\n`;
  const root = citationFixture(source, citation.replace(sectionHash, hash));
  expect(run(root)).toEqual({ status: 0, output: '' });
  writeFileSync(join(root, 'rules.md'), source.replace('Fake title', 'Changed sample'));
  expect(run(root).output).toContain('citation hash mismatch');
});

test('a setext heading ends a cited section before the title line', () => {
  const root = citationFixture(citedSource.replace('## Other', 'Other\n-----'));
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test('a stray setext underline changes the extent instead of becoming an ordinary rule', () => {
  const root = citationFixture(citedSource.replace('Keep this too.', 'Keep this too.\n---'));
  expect(run(root).output).toContain('citation hash mismatch');
});

test.each([
  '- Rule.',
  '* Rule.',
  '+ Rule.',
  '1. Rule.',
  '1) Rule.',
  '- Rule.\n  continued line.',
  '- Rule.\ncontinued lazily.',
  '> Quote.\nlazy line.',
  '| a | b |',
])('a thematic break after list item %s cannot shorten a cited extent', (item) => {
  const body = `Introduction.\n\n${item}\n---\n\nKeep this too.`;
  const hash = createHash('sha256').update(body).digest('hex');
  const source = citedSource.replace(sectionBody, body);
  const root = citationFixture(source, citation.replace(sectionHash, hash));
  expect(run(root)).toEqual({ status: 0, output: '' });
  writeFileSync(join(root, 'rules.md'), source.replace('Keep this too.', 'Changed rule.'));
  expect(run(root).output).toContain('citation hash mismatch');
  const shortened = createHash('sha256').update('Introduction.').digest('hex');
  const forged = run(citationFixture(source, citation.replace(sectionHash, shortened)));
  expect(forged.status).toBe(1);
  expect(forged.output).toContain('citation hash mismatch');
});

test('can cite a setext heading without hashing its underline', () => {
  expect(run(citationFixture(citedSource.replace('## Never', 'Never\n-----')))).toEqual({
    status: 0,
    output: '',
  });
});

test('refresh refuses invalid targets without rewriting any citations', () => {
  const root = citationFixture(citedSource.replace('## Never', '## Renamed'));
  const before = readFileSync(join(root, citationFile));
  expect(run(root, '--refresh-citations').status).toBe(1);
  expect(readFileSync(join(root, citationFile))).toEqual(before);
});

test('rejects a malformed citation rather than silently skipping it', () => {
  const result = run(citationFixture(citedSource, citation.replace(sectionHash, 'not-a-hash')));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:3: invalid citation`);
});

test.each([
  ['an extra space', citation.replace('<!-- ', '<!--  ')],
  ['no space', citation.replace('<!-- ', '<!--')],
])('rejects a citation comment with %s rather than skipping it', (_name, comment) => {
  const result = run(citationFixture(citedSource, comment));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:3: invalid citation`);
});

test('rejects a citation of an empty section', () => {
  const root = citationFixture('# Rules\n\n## Never\n\n## Other\n\nNot cited.\n');
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:3: empty citation section: rules.md#Never`);
});

test('an unpaired backtick does not hide later paragraphs from the claim and citation checks', () => {
  const stale = citation.replace(sectionHash, '0'.repeat(64));
  const root = fixture({
    'rules.md': citedSource,
    [citationFile]: `# Guidance\n\nStray tick \`\n\nThis app is secure.\n\n${stale}\nRule.\n\nAnother tick \`\n`,
  });
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${citationFile}:5: banned claim: secure`);
  expect(result.output).toContain(`${citationFile}:7: citation hash mismatch`);
});

test('ignores citation examples in fences and inline code', () => {
  const root = fixture({
    [citationFile]:
      '# Examples\n\n`<!-- galaxie:cite invalid -->`\n\n```md\n<!-- galaxie:cite invalid -->\n```\n',
  });
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each([
  'skills/galaxie/SKILL.md',
  'skills/galaxie/references/nested/guide.md',
  'templates/base/files/README.md',
  'templates/kinds/demo/files/README.md',
  'templates/frameworks/demo/files/guide.md',
])('checks banned claims throughout %s', (file) => {
  const result = run(fixture({ [file]: '# Guide\n\nA secure app.\n' }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`${file}:3: banned claim: secure`);
});

test.each(['secure', 'secured', 'compliant', 'certified', 'SECURE', 'Certified'])(
  'rejects the banned prose claim %s',
  (word) => {
    const result = run(fixture({ [citationFile]: `# Guide\n\nAn app is ${word}.\n` }));
    expect(result.status).toBe(1);
    expect(result.output).toContain(`${citationFile}:3: banned claim: ${word}`);
  },
);

test('masks fenced examples and inline words named by a prohibition, and allows nouns', () => {
  const root = fixture({
    [citationFile]: [
      '---',
      'name: galaxie',
      'description: security guidance',
      'version: 0.1.0',
      '---',
      '# Guide',
      'Security and compliance are nouns.',
      'Never call galaxie or generated',
      'apps `secure`, `secured`, `compliant` or `certified`.',
      '```md',
      'secure secured compliant certified',
      '```',
      '~~~md',
      'SECURE',
      '~~~',
    ].join('\n'),
  });
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each([
  'This app is `secure`.',
  'This app is ``compliant ` example``.',
  'This app is `multiline\ncertified\n`.',
  'Never call this app `secure`. This app is `certified`.',
  'Do not delete files. This app is `secured`.',
  'Never call anything `secure`, but galaxie is `certified`.',
  'Never call anything `secure`; galaxie is `certified`.',
  'Never call anything `secure` and galaxie is `certified`.',
  'Never call anything silly but galaxie is `secure`.',
  'Never call anything silly and galaxie is `secure`.',
])('inline code cannot hide a claim: %s', (claim) => {
  const result = run(fixture({ [citationFile]: `# Guide\n\n${claim}\n` }));
  expect(result.status).toBe(1);
  expect(result.output).toContain('banned claim:');
});

test('keeps banned-claim scope to guidance and template Markdown', () => {
  expect(run(fixture({ 'guide.md': 'The word secure outside guidance.\n' }))).toEqual({
    status: 0,
    output: '',
  });
});

test('checks prose claims in skill frontmatter descriptions', () => {
  const result = run(
    fixture({
      'skills/galaxie/SKILL.md':
        '---\nname: galaxie\ndescription: A secure app.\nversion: 0.1.0\n---\n# Guide\n',
    }),
  );
  expect(result.status).toBe(1);
  expect(result.output).toContain('skills/galaxie/SKILL.md:3: banned claim: secure');
});

test('preserves citation source CRLF and all non-hash bytes on refresh', () => {
  const root = citationFixture();
  const source = `# Guidance\r\n\r\n${citation.replace(sectionHash, '0'.repeat(64))}\r\nKeep checks.\r\n`;
  writeFileSync(join(root, citationFile), source);
  expect(run(root, '--refresh-citations')).toEqual({ status: 0, output: '' });
  expect(readFileSync(join(root, citationFile), 'utf8')).toBe(
    source.replace('0'.repeat(64), sectionHash),
  );
});

test('accepts a heading containing inline code in the citation attribute', () => {
  const root = citationFixture(
    citedSource.replace('## Never', '## Never `eval`'),
    citation.replace('heading="Never"', 'heading="Never `eval`"'),
  );
  expect(run(root)).toEqual({ status: 0, output: '' });
});

const tracingSourceFile = 'packages/core/src/tracing.ts';
const tracingGuideFile = 'docs/guides/tracing.md';
const repo = fileURLToPath(new URL('../..', import.meta.url));

function tracingFixture(): string {
  const guide = readFileSync(join(repo, tracingGuideFile), 'utf8');
  const table = guide.slice(guide.indexOf('| Span or outcome |')).split('\n\n')[0];
  return fixture({
    [tracingSourceFile]: readFileSync(join(repo, tracingSourceFile), 'utf8'),
    [tracingGuideFile]: `# Tracing\n\n${table}\n`,
  });
}

test.each([
  "span.setAttribute('galaxie.fixture', 'value');",
  "span['setAttribute'](`galaxie.fixture`, 'value');",
  "span.setAttributes({ 'galaxie.fixture': 'value' });",
  "span.setAttributes({ ['galaxie.fixture']: 'value' });",
  "span.setAttributes({ fixture: 'value' });",
  "span.setAttribute(('galaxie.fixture'), 'value');",
  "span.setAttribute(('galaxie.fixture' as string)!, 'value');",
  "span.setAttribute((<string>'galaxie.fixture'), 'value');",
  "span.setAttribute(('galaxie.fixture' satisfies string), 'value');",
  "(span.setAttribute)('galaxie.fixture', 'value');",
  "span[('setAttribute')]('galaxie.fixture', 'value');",
  "span.setAttributes(({ 'galaxie.fixture': 'value' }) as Attributes);",
  "span.setAttributes({ ...({ ...{ 'galaxie.fixture': 'value' } } as Attributes) });",
  "span.setAttributes({ [('galaxie.fixture' as const)]: 'value' });",
])('rejects a literal tracing write outside the inventory helpers: %s', (write) => {
  const root = tracingFixture();
  const source = readFileSync(join(root, tracingSourceFile), 'utf8');
  writeFileSync(join(root, tracingSourceFile), `${source}\nfunction bypass(): void { ${write} }\n`);
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain('literal tracing write outside attributes()/text():');
});

test('accepts tracing writes routed through the metadata and text helpers', () => {
  const root = tracingFixture();
  const source = readFileSync(join(root, tracingSourceFile), 'utf8');
  writeFileSync(
    join(root, tracingSourceFile),
    `${source}\nspan.setAttributes((attributes({ 'galaxie.run.status': 'ok' })) as Attributes);\n`,
  );
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test('rejects an emitted tracing key without a table entry in a temporary source copy', () => {
  const root = tracingFixture();
  const source = readFileSync(join(root, tracingSourceFile), 'utf8');
  writeFileSync(
    join(root, tracingSourceFile),
    source.replace('const ALLOWED = new Set([', "const ALLOWED = new Set(['galaxie.mutation',"),
  );
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain('missing tracing attribute: galaxie.mutation');
});

test('rejects a new development-text key without a table entry', () => {
  const root = tracingFixture();
  const source = readFileSync(join(root, tracingSourceFile), 'utf8');
  writeFileSync(
    join(root, tracingSourceFile),
    source.replace(
      "key: 'gen_ai.input.messages'",
      "key: 'gen_ai.mutation' | 'gen_ai.input.messages'",
    ),
  );
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain('missing tracing attribute: gen_ai.mutation');
});

test('rejects a removed tracing table row in a temporary guide copy', () => {
  const root = tracingFixture();
  const guide = readFileSync(join(root, tracingGuideFile), 'utf8');
  writeFileSync(join(root, tracingGuideFile), guide.replace(/^\| Node \|.*\n/m, ''));
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toContain('missing tracing attribute: galaxie.node.name');
  expect(result.output).toContain('missing tracing attribute: galaxie.node.step');
});

test('names an unknown attribute and its table row', () => {
  const root = tracingFixture();
  const guide = readFileSync(join(root, tracingGuideFile), 'utf8');
  writeFileSync(join(root, tracingGuideFile), `${guide}| Invented | \`galaxie.not_emitted\` |\n`);
  const result = run(root);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(
    /docs\/guides\/tracing\.md:\d+: unknown tracing attribute: galaxie.not_emitted; row: Invented/,
  );
});

test('reads attribute columns only, ignoring span names, values, symbols and fenced examples', () => {
  const root = fixture({
    [tracingSourceFile]: `// A misleading 'galaxie.comment' key.
const ALLOWED = new Set<string>([
  'galaxie.fixture', // Only this Set supplies metadata keys.
]);
const marker = Symbol('galaxie.symbol');
const span = tracer.startSpan('galaxie.span');
const text = (span: Span, key: 'gen_ai.input.messages' | 'gen_ai.output.messages', value: unknown): void => {};
`,
    [tracingGuideFile]: `# Tracing

| Span or outcome | Emitted attributes |
| --- | --- |
| \`galaxie.span\` | \`galaxie.fixture\` (\`bounded-value\`), \`gen_ai.input.messages\`, \`gen_ai.output.messages\` |

\`galaxie.prose\` is not an attribute row.

\`\`\`md
| Span or outcome | Emitted attributes |
| --- | --- |
| Example | \`galaxie.fenced\` |
\`\`\`
`,
  });
  expect(run(root)).toEqual({ status: 0, output: '' });
});

test.each([
  ['const ALLOWED = new Set([]);', 'ALLOWED'],
  ["const ALLOWED = new Set(['galaxie.fixture']);", 'text'],
  ['const ALLOWED = new Set(keys);', 'ALLOWED'],
  [
    "const ALLOWED = new Set(['galaxie.fixture']); const text = (span: Span, key: string) => {};",
    'text',
  ],
])('fails loudly if tracing source extraction is empty or unsupported: %s', (source, member) => {
  const result = run(fixture({ [tracingSourceFile]: source }));
  expect(result.status).toBe(1);
  expect(result.output).toContain(`cannot extract tracing attributes from ${member}`);
});

test('rejects a missing tracing attribute table instead of silently comparing no rows', () => {
  const result = run(fixture({ [tracingGuideFile]: '# Tracing\n' }));
  expect(result.status).toBe(1);
  expect(result.output).toContain('missing tracing attribute table');
});
