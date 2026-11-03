// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import {
  localModelKey,
  modelCacheName,
  modelFileUrl,
  parseModelRecord,
  totalBytes,
} from '../src/transformers/model-record.js';

const revision = '0123456789abcdef0123456789abcdef01234567';
const hash = (digit: string): string => digit.repeat(64);
const files = [
  { path: 'config.json', bytes: 600, sha256: hash('a') },
  { path: 'tokenizer.json', bytes: 9000, sha256: hash('b') },
  { path: 'tokenizer_config.json', bytes: 1200, sha256: hash('c') },
  { path: 'onnx/model_q4.onnx', bytes: 70000, sha256: hash('d') },
];
const valid = {
  modelId: 'example-org/tiny-chat',
  baseUrl: `https://models.example.test/example-org/tiny-chat/resolve/${revision}/`,
  revision,
  device: 'webgpu',
  dtype: 'q4f16',
  contextWindow: 4096,
  toolFormat: 'hermes',
  template: { enableThinking: false },
  files,
};

function failure(value: unknown): unknown {
  try {
    parseModelRecord(value);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('Transformers.js model record', () => {
  it('accepts a synthetic record and returns a deeply frozen copy', () => {
    const input = structuredClone(valid);
    const record = parseModelRecord(input);
    expect(record).toEqual(valid);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.files)).toBe(true);
    expect(record.files.every((file) => Object.isFrozen(file))).toBe(true);
    expect(Object.isFrozen(record.template)).toBe(true);
    input.files[0] = { path: 'other.json', bytes: 1, sha256: hash('f') };
    input.contextWindow = 1;
    expect(record.files[0]?.path).toBe('config.json');
    expect(record.contextWindow).toBe(4096);
  });

  it('accepts a same-origin base, no tool format, no template and either device', () => {
    const { toolFormat: _tool, template: _template, ...bare } = valid;
    for (const device of ['webgpu', 'wasm'])
      expect(() =>
        parseModelRecord({
          ...bare,
          device,
          baseUrl: `/models/tiny/resolve/${revision}/`,
        }),
      ).not.toThrow();
  });

  const bad = (change: Record<string, unknown>): Record<string, unknown> => ({
    ...valid,
    ...change,
  });
  const withFiles = (list: unknown[]): Record<string, unknown> => bad({ files: list });
  const without = (path: string): unknown[] => files.filter((file) => file.path !== path);
  const canary = 'canary-private-text';

  it.each([
    ['cleartext http base', bad({ baseUrl: `http://models.example.test/m/resolve/${revision}/` })],
    ['protocol-relative base', bad({ baseUrl: `//models.example.test/m/resolve/${revision}/` })],
    [
      'credentials in the base',
      bad({ baseUrl: `https://user:${canary}@models.example.test/m/resolve/${revision}/` }),
    ],
    [
      'query in the base',
      bad({ baseUrl: `https://models.example.test/m/resolve/${revision}/?t=1` }),
    ],
    ['hash in the base', bad({ baseUrl: `https://models.example.test/m/resolve/${revision}/#x` })],
    ['branch name in the base', bad({ baseUrl: 'https://models.example.test/m/resolve/main/' })],
    [
      'dot segments in the base',
      bad({ baseUrl: `https://models.example.test/m/x/../resolve/${revision}/` }),
    ],
    [
      'a base for another revision',
      bad({ baseUrl: `https://models.example.test/m/resolve/${'f'.repeat(40)}/` }),
    ],
    [
      'a base without a trailing slash',
      bad({ baseUrl: `https://models.example.test/m/resolve/${revision}` }),
    ],
    ['a branch name as the revision', bad({ revision: 'main' })],
    ['a 39 character revision', bad({ revision: revision.slice(1) })],
    ['an uppercase revision', bad({ revision: revision.toUpperCase() })],
    ['an empty model id', bad({ modelId: '' })],
    ['a model id with path tricks', bad({ modelId: '../escape' })],
    ['an unknown device', bad({ device: 'cpu' })],
    ['an unknown dtype', bad({ dtype: 'q5' })],
    ['an unknown tool format', bad({ toolFormat: 'json' })],
    ['an unknown template option', bad({ template: { systemPrompt: canary } })],
    ['a non-boolean thinking flag', bad({ template: { enableThinking: 'no' } })],
    ['an unknown record field', bad({ onFailure: 'warn' })],
    ['a zero context window', bad({ contextWindow: 0 })],
    ['a fractional context window', bad({ contextWindow: 1.5 })],
    ['an unsafe context window', bad({ contextWindow: Number.MAX_SAFE_INTEGER + 2 })],
    ['no files', withFiles([])],
    ['files that are not a list', bad({ files: { path: 'config.json' } })],
    ['config.json missing', withFiles(without('config.json'))],
    ['tokenizer.json missing', withFiles(without('tokenizer.json'))],
    ['tokenizer_config.json missing', withFiles(without('tokenizer_config.json'))],
    ['a duplicate path', withFiles([...files, { ...files[0] }])],
    ['a parent path', withFiles([...files, { path: `../${canary}`, bytes: 1, sha256: hash('e') }])],
    [
      'an absolute path',
      withFiles([...files, { path: `/${canary}`, bytes: 1, sha256: hash('e') }]),
    ],
    [
      'an empty path segment',
      withFiles([...files, { path: `onnx//${canary}`, bytes: 1, sha256: hash('e') }]),
    ],
    [
      'a backslash path',
      withFiles([...files, { path: `onnx\\${canary}`, bytes: 1, sha256: hash('e') }]),
    ],
    [
      'a query in a path',
      withFiles([...files, { path: `x.bin?${canary}`, bytes: 1, sha256: hash('e') }]),
    ],
    [
      'a 65 character hash',
      withFiles([...files.slice(0, 3), { ...files[3], sha256: `${hash('d')}0` }]),
    ],
    ['an uppercase hash', withFiles([...files.slice(0, 3), { ...files[3], sha256: hash('D') }])],
    ['a zero byte file', withFiles([...files.slice(0, 3), { ...files[3], bytes: 0 }])],
    ['a fractional size', withFiles([...files.slice(0, 3), { ...files[3], bytes: 10.5 }])],
    ['a file over 1 GiB', withFiles([...files.slice(0, 3), { ...files[3], bytes: 1024 ** 3 + 1 }])],
    ['an unknown file field', withFiles([...files.slice(0, 3), { ...files[3], url: canary }])],
    [
      'more than 64 files',
      withFiles([
        ...files,
        ...Array.from({ length: 61 }, (_, index) => ({
          path: `extra/${index}.bin`,
          bytes: 1,
          sha256: hash('e'),
        })),
      ]),
    ],
    ['a string', 'prompt sentence'],
    ['null', null],
    ['an array', [valid]],
  ])('rejects %s with a fixed invalid error that omits the value', (_name, value) => {
    const error = failure(value);
    expect(error).toMatchObject({
      name: 'GalaxieError',
      code: 'invalid',
      message: 'The model request is invalid.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain(canary);
    expect(String(error)).not.toContain(canary);
  });

  it('accepts exactly 64 files and a file of exactly 1 GiB', () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      path: `extra/${index}.bin`,
      bytes: 1,
      sha256: hash('e'),
    }));
    const large = { path: 'onnx/model_q4.onnx', bytes: 1024 ** 3, sha256: hash('d') };
    expect(() =>
      parseModelRecord({ ...valid, files: [...files.slice(0, 3), large, ...many] }),
    ).not.toThrow();
  });

  it('derives the download size, cache name and file keys from the record', () => {
    const record = parseModelRecord(valid);
    expect(totalBytes(record)).toBe(80800);
    expect(modelCacheName(record)).toBe(`galaxie-transformers:example-org/tiny-chat@${revision}`);
    const file = record.files[3];
    if (file === undefined) throw new Error('missing file');
    expect(modelFileUrl(record, file)).toBe(
      `https://models.example.test/example-org/tiny-chat/resolve/${revision}/onnx/model_q4.onnx`,
    );
    expect(localModelKey(record, file)).toBe(
      '/verified-models/example-org/tiny-chat/onnx/model_q4.onnx',
    );
  });

  it('resolves a same-origin base against the page and rejects it when there is none', () => {
    const record = parseModelRecord({ ...valid, baseUrl: `/models/tiny/resolve/${revision}/` });
    const file = record.files[0];
    if (file === undefined) throw new Error('missing file');
    expect(() => modelFileUrl(record, file)).toThrow(/invalid/);
    vi.stubGlobal('location', { href: 'https://app.example.test/index.html' });
    try {
      expect(modelFileUrl(record, file)).toBe(
        `https://app.example.test/models/tiny/resolve/${revision}/config.json`,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
