// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';

export type TransformersDevice = 'webgpu' | 'wasm';

/** The dtype names Transformers.js 4.3.2 maps to ONNX file suffixes. */
export const transformersDtypes = [
  'fp32',
  'fp16',
  'int8',
  'uint8',
  'q8',
  'q4',
  'q2',
  'q1',
  'q4f16',
  'q2f16',
  'q1f16',
  'bnb4',
] as const;
export type TransformersDtype = (typeof transformersDtypes)[number];

export interface TransformersModelFile {
  /** A relative path below the record's `baseUrl`. */
  readonly path: string;
  readonly bytes: number;
  /** Lowercase hex SHA-256 of the file. */
  readonly sha256: string;
}

export interface TransformersModelRecord {
  readonly modelId: string;
  /** An `https://` or same-origin URL ending in `/resolve/<revision>/`. */
  readonly baseUrl: string;
  /** An immutable 40-hex commit revision. */
  readonly revision: string;
  readonly device: TransformersDevice;
  readonly dtype: TransformersDtype;
  readonly contextWindow: number;
  readonly toolFormat?: 'hermes';
  readonly template?: { readonly enableThinking?: boolean };
  readonly files: readonly TransformersModelFile[];
}

/** The `localModelPath` under which the runtime asks the read-only cache for record files. */
export const verifiedModelPath = '/verified-models/';

const maxFileBytes = 1024 ** 3;
const maxFiles = 64;
const requiredFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const;
const revisionPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const segmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const modelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$/;

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function only(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function sizeInRange(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function validBaseUrl(value: unknown, revision: string): value is string {
  if (
    typeof value !== 'string' ||
    // Weights are verified by hash, but a cleartext transfer still leaks what is being downloaded.
    (!value.startsWith('/') && !value.startsWith('https://')) ||
    value.startsWith('//')
  )
    return false;
  try {
    const url = new URL(value, 'https://validation.invalid/');
    const path = value.startsWith('/') ? value : value.slice(value.indexOf('/', 'https://'.length));
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      // A normalized path that differs from the written one hides dot segments or backslashes.
      url.pathname === path &&
      // An https base must already be in the form the runtime will build its keys from.
      (value.startsWith('/') || url.href === value) &&
      path.endsWith(`/resolve/${revision}/`)
    );
  } catch {
    return false;
  }
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 256 &&
    value.split('/').every((segment) => segmentPattern.test(segment))
  );
}

function parseFile(value: unknown): TransformersModelFile | undefined {
  if (!plain(value) || !only(value, ['path', 'bytes', 'sha256'])) return undefined;
  // Read each field once, so a getter cannot answer differently for the check and the copy.
  const { path, bytes, sha256 } = value;
  if (
    !validPath(path) ||
    !sizeInRange(bytes, maxFileBytes) ||
    typeof sha256 !== 'string' ||
    !sha256Pattern.test(sha256)
  )
    return undefined;
  return Object.freeze({ path, bytes, sha256 });
}

function parseFiles(value: unknown): readonly TransformersModelFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxFiles) return undefined;
  const files: TransformersModelFile[] = [];
  const paths = new Set<string>();
  for (const entry of value as unknown[]) {
    const file = parseFile(entry);
    if (file === undefined || paths.has(file.path)) return undefined;
    paths.add(file.path);
    files.push(file);
  }
  return requiredFiles.every((path) => paths.has(path)) ? Object.freeze(files) : undefined;
}

function parseTemplate(value: unknown): TransformersModelRecord['template'] | false {
  if (!plain(value) || !only(value, ['enableThinking'])) return false;
  const thinking = value['enableThinking'];
  if (thinking !== undefined && typeof thinking !== 'boolean') return false;
  return Object.freeze(thinking === undefined ? {} : { enableThinking: thinking });
}

/**
 * Checks a pinned record and returns a deeply frozen copy. Every failure is a fixed `invalid`
 * error that carries none of the rejected value.
 */
export function parseModelRecord(value: unknown): TransformersModelRecord {
  if (
    !plain(value) ||
    !only(value, [
      'modelId',
      'baseUrl',
      'revision',
      'device',
      'dtype',
      'contextWindow',
      'toolFormat',
      'template',
      'files',
    ])
  )
    throw new ModelError('invalid');
  const { modelId, baseUrl, revision, device, dtype, contextWindow, toolFormat } = value;
  const { files: fileList, template: templateValue } = value;
  const files = parseFiles(fileList);
  const template = templateValue === undefined ? undefined : parseTemplate(templateValue);
  if (
    typeof modelId !== 'string' ||
    !modelIdPattern.test(modelId) ||
    typeof revision !== 'string' ||
    !revisionPattern.test(revision) ||
    !validBaseUrl(baseUrl, revision) ||
    (device !== 'webgpu' && device !== 'wasm') ||
    !transformersDtypes.includes(dtype as TransformersDtype) ||
    !sizeInRange(contextWindow, Number.MAX_SAFE_INTEGER) ||
    (toolFormat !== undefined && toolFormat !== 'hermes') ||
    template === false ||
    files === undefined ||
    !Number.isSafeInteger(files.reduce((sum, file) => sum + file.bytes, 0))
  )
    throw new ModelError('invalid');
  return Object.freeze({
    modelId,
    baseUrl,
    revision,
    device,
    dtype: dtype as TransformersDtype,
    contextWindow,
    ...(toolFormat === undefined ? {} : { toolFormat }),
    ...(template === undefined ? {} : { template }),
    files,
  });
}

/** The sum of the record's file sizes, which is the download size a host reports. */
export function totalBytes(record: TransformersModelRecord): number {
  return record.files.reduce((sum, file) => sum + file.bytes, 0);
}

/** The Cache Storage cache that holds one model revision. */
export function modelCacheName(record: TransformersModelRecord): string {
  return `galaxie-transformers:${record.modelId}@${record.revision}`;
}

/** The absolute URL a record file is stored under; same-origin bases resolve against the page. */
export function modelFileUrl(record: TransformersModelRecord, file: TransformersModelFile): string {
  try {
    return new URL(`${record.baseUrl}${file.path}`, globalThis.location?.href).href;
  } catch {
    throw new ModelError('invalid');
  }
}

/** The key under which the runtime asks for a file when it reads from `verifiedModelPath`. */
export function localModelKey(
  record: TransformersModelRecord,
  file: TransformersModelFile,
): string {
  return `${verifiedModelPath}${record.modelId}/${file.path}`;
}
