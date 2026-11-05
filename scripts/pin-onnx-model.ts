// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Template } from '@huggingface/jinja';

/**
 * Maintainer-run: reads a Hugging Face model repository at one revision, downloads and hashes the
 * files an ONNX chat provider needs, and prints a `TransformersModelRecord` (ADR-0021 decision 9)
 * with the model card license and a chat-template probe. It is never part of CI and its tests
 * inject `fetch`. This script applies the record's size and file-count limits itself, and its
 * tests check every printed record with the package's `parseModelRecord`.
 */

const huggingFace = 'https://huggingface.co';
const maxFileBytes = 1024 ** 3;
const maxFiles = 64;
const defaultContextWindow = 4096;

/** The ONNX file suffix Transformers.js 4.3.2 uses for each dtype. */
const dtypeSuffixes = {
  fp32: '',
  fp16: '_fp16',
  int8: '_int8',
  uint8: '_uint8',
  q8: '_quantized',
  q4: '_q4',
  q2: '_q2',
  q1: '_q1',
  q4f16: '_q4f16',
  q2f16: '_q2f16',
  q1f16: '_q1f16',
  bnb4: '_bnb4',
} as const;
export type PinDtype = keyof typeof dtypeSuffixes;
export const pinDtypes: readonly string[] = Object.keys(dtypeSuffixes);

const requiredFiles = ['config.json', 'tokenizer.json', 'tokenizer_config.json'] as const;
const optionalFiles = [
  'generation_config.json',
  'special_tokens_map.json',
  'added_tokens.json',
  'chat_template.jinja',
] as const;
/** Small files whose text the script reads after hashing them. */
const textFiles = new Set(['config.json', 'tokenizer_config.json', 'chat_template.jinja']);

export const usage: string =
  'Usage: node scripts/pin-onnx-model.ts <modelId> <revision> <dtype> [--device webgpu|wasm] [--context-window <tokens>]\n' +
  '  <revision> is a 40-hex commit; <dtype> is one of: ' +
  `${pinDtypes.join(', ')}.`;

export interface PinRequest {
  readonly modelId: string;
  readonly revision: string;
  readonly dtype: PinDtype;
  readonly device: 'webgpu' | 'wasm';
  /** Defaults to the model's `max_position_embeddings`, capped at 4096. */
  readonly contextWindow?: number;
}

export interface PinnedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PinnedRecord {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly revision: string;
  readonly device: 'webgpu' | 'wasm';
  readonly dtype: PinDtype;
  readonly contextWindow: number;
  readonly toolFormat?: 'hermes';
  readonly files: readonly PinnedFile[];
}

export interface TemplateOutcome {
  readonly rendered: true;
  /** The tool declaration reached the rendered prompt. */
  readonly declarations: boolean;
  /** The assistant tool call and the tool result reached the rendered prompt. */
  readonly calls: boolean;
  readonly results: boolean;
  /** Declarations plus `<tool_call>` markup: the record gets `toolFormat: 'hermes'`. */
  readonly hermes: boolean;
  /** The template reads `enable_thinking`; set the record's `template` option by hand if needed. */
  readonly mentionsEnableThinking: boolean;
}

export interface PinResult {
  readonly record: PinnedRecord;
  /** The model card license, or `null` when the card names none. */
  readonly license: string | null;
  readonly template: TemplateOutcome;
}

export interface PinDependencies {
  readonly fetch?: typeof fetch;
  readonly log?: (line: string) => void;
}

/** Failures carry a fixed message only; the cause is dropped on purpose. */
export class PinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PinError';
  }
}

export function parseArguments(argv: readonly string[]): PinRequest | undefined {
  const positional: string[] = [];
  let device: string = 'webgpu';
  let contextWindow: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === '--device') device = argv[++index] ?? '';
    else if (argument === '--context-window') contextWindow = Number(argv[++index]);
    else if (argument.startsWith('--')) return undefined;
    else positional.push(argument);
  }
  const [modelId, revision, dtype] = positional;
  if (
    positional.length !== 3 ||
    modelId === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,95})?$/.test(modelId) ||
    revision === undefined ||
    !/^[0-9a-f]{40}$/.test(revision) ||
    dtype === undefined ||
    !Object.hasOwn(dtypeSuffixes, dtype) ||
    (device !== 'webgpu' && device !== 'wasm') ||
    (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1))
  )
    return undefined;
  return {
    modelId,
    revision,
    dtype: dtype as PinDtype,
    device,
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

interface TreeEntry {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly size?: unknown;
}

async function getJson(
  fetcher: typeof fetch,
  url: string,
  failure: string,
  complete = false,
): Promise<unknown> {
  try {
    const response = await fetcher(url, { credentials: 'omit' });
    // A paginated listing would silently omit files, so it is refused instead.
    if (!response.ok || (complete && /rel="?next"?/.test(response.headers.get('link') ?? '')))
      throw new Error();
    return await response.json();
  } catch {
    throw new PinError(failure);
  }
}

/** The repository files at the revision, with the sizes the listing reports. */
async function listFiles(
  fetcher: typeof fetch,
  request: PinRequest,
): Promise<Map<string, number | undefined>> {
  const tree = await getJson(
    fetcher,
    `${huggingFace}/api/models/${request.modelId}/tree/${request.revision}?recursive=true`,
    'The model file list could not be read.',
    true,
  );
  if (!Array.isArray(tree)) throw new PinError('The model file list could not be read.');
  const files = new Map<string, number | undefined>();
  for (const entry of tree as TreeEntry[])
    if (entry?.type === 'file' && typeof entry.path === 'string')
      files.set(entry.path, typeof entry.size === 'number' ? entry.size : undefined);
  return files;
}

function selectPaths(
  request: PinRequest,
  listed: ReadonlyMap<string, number | undefined>,
): string[] {
  const suffix = dtypeSuffixes[request.dtype].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const weights = new RegExp(`^onnx/model${suffix}\\.onnx(?:_data(?:_\\d+)?)?$`);
  const paths = [...listed.keys()].filter(
    (path) =>
      (requiredFiles as readonly string[]).includes(path) ||
      (optionalFiles as readonly string[]).includes(path) ||
      weights.test(path),
  );
  const missing =
    !requiredFiles.every((path) => paths.includes(path)) ||
    !paths.includes(`onnx/model${dtypeSuffixes[request.dtype]}.onnx`);
  if (missing || paths.length > maxFiles)
    throw new PinError('The model repository lacks a file the provider needs.');
  return paths.sort();
}

async function hashFile(
  fetcher: typeof fetch,
  request: PinRequest,
  path: string,
  listedSize: number | undefined,
): Promise<{ file: PinnedFile; text: string | undefined }> {
  try {
    const response = await fetcher(
      `${huggingFace}/${request.modelId}/resolve/${request.revision}/${path}`,
      { credentials: 'omit' },
    );
    if (!response.ok || response.body === null) throw new Error();
    const hash = createHash('sha256');
    const kept: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > maxFileBytes) throw new Error();
      hash.update(chunk);
      if (textFiles.has(path)) kept.push(chunk);
    }
    if (bytes < 1 || (listedSize !== undefined && listedSize !== bytes)) throw new Error();
    return {
      file: { path, bytes, sha256: hash.digest('hex') },
      text: textFiles.has(path) ? Buffer.concat(kept).toString('utf8') : undefined,
    };
  } catch {
    throw new PinError('A model file could not be downloaded and hashed.');
  }
}

async function readLicense(fetcher: typeof fetch, request: PinRequest): Promise<string | null> {
  const card = (await getJson(
    fetcher,
    `${huggingFace}/api/models/${request.modelId}/revision/${request.revision}`,
    'The model card could not be read.',
  )) as { cardData?: { license?: unknown }; tags?: unknown } | null;
  const license = card?.cardData?.license;
  if (typeof license === 'string' && license !== '') return license;
  if (Array.isArray(card?.tags)) {
    const tag = (card.tags as unknown[]).find(
      (entry): entry is string => typeof entry === 'string' && entry.startsWith('license:'),
    );
    if (tag !== undefined) return tag.slice('license:'.length);
  }
  return null;
}

function tokenText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    const content = (value as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }
  return '';
}

function chatTemplate(tokenizerConfig: Record<string, unknown>, jinja: string | undefined): string {
  if (jinja !== undefined) return jinja;
  const template = tokenizerConfig['chat_template'];
  if (typeof template === 'string') return template;
  if (Array.isArray(template)) {
    const entries = template as { name?: unknown; template?: unknown }[];
    const chosen = entries.find((entry) => entry?.name === 'default') ?? entries[0];
    if (typeof chosen?.template === 'string') return chosen.template;
  }
  throw new PinError('The model has no chat template.');
}

const probeTools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Look up the weather for one city.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  },
];
const probeMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Is it warm outside?' },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'get_weather', arguments: { city: 'Hanoi' } },
      },
    ],
  },
  { role: 'tool', content: '{"temperature":31}' },
];

/** Renders a fixed conversation with a tool declaration, a tool call and a tool result. */
export function probeTemplate(
  source: string,
  tokenizerConfig: Record<string, unknown>,
): TemplateOutcome {
  let output: string;
  try {
    output = new Template(source).render({
      messages: probeMessages,
      tools: probeTools,
      add_generation_prompt: true,
      bos_token: tokenText(tokenizerConfig['bos_token']),
      eos_token: tokenText(tokenizerConfig['eos_token']),
    });
  } catch {
    throw new PinError('The chat template could not be rendered.');
  }
  const declarations = output.includes('Look up the weather for one city.');
  const calls = output.includes('Hanoi');
  const results = output.includes('temperature');
  return {
    rendered: true,
    declarations,
    calls,
    results,
    hermes: declarations && calls && results && output.includes('<tool_call>'),
    mentionsEnableThinking: source.includes('enable_thinking'),
  };
}

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text ?? '');
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {}
  throw new PinError('A model configuration file is not valid JSON.');
}

export async function pinModel(
  request: PinRequest,
  dependencies: PinDependencies = {},
): Promise<PinResult> {
  const fetcher = dependencies.fetch ?? fetch;
  const log = dependencies.log ?? (() => undefined);
  const listed = await listFiles(fetcher, request);
  const paths = selectPaths(request, listed);
  const files: PinnedFile[] = [];
  const texts = new Map<string, string>();
  const hash = async (path: string): Promise<void> => {
    log(`Hashing ${path}`);
    const { file, text } = await hashFile(fetcher, request, path, listed.get(path));
    files.push(file);
    if (text !== undefined) texts.set(path, text);
  };
  // The small text files come first, so a model that fails the template or context checks is
  // rejected before any weight shard is downloaded.
  for (const path of paths.filter((entry) => textFiles.has(entry))) await hash(path);
  const tokenizerConfig = parseJsonObject(texts.get('tokenizer_config.json'));
  const template = probeTemplate(
    chatTemplate(tokenizerConfig, texts.get('chat_template.jinja')),
    tokenizerConfig,
  );
  const maxPositions = parseJsonObject(texts.get('config.json'))['max_position_embeddings'];
  const contextWindow =
    request.contextWindow ??
    (typeof maxPositions === 'number' && Number.isSafeInteger(maxPositions) && maxPositions > 0
      ? Math.min(maxPositions, defaultContextWindow)
      : undefined);
  if (contextWindow === undefined) throw new PinError('Pass --context-window for this model.');
  const license = await readLicense(fetcher, request);
  for (const path of paths.filter((entry) => !textFiles.has(entry))) await hash(path);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    record: {
      modelId: request.modelId,
      baseUrl: `${huggingFace}/${request.modelId}/resolve/${request.revision}/`,
      revision: request.revision,
      device: request.device,
      dtype: request.dtype,
      contextWindow,
      ...(template.hermes ? { toolFormat: 'hermes' as const } : {}),
      files,
    },
    license,
    template,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const request = parseArguments(process.argv.slice(2));
  if (request === undefined) {
    console.error(usage);
    process.exitCode = 1;
  } else {
    try {
      const result = await pinModel(request, { log: (line) => console.error(line) });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error(error instanceof PinError ? error.message : 'The model could not be pinned.');
      process.exitCode = 1;
    }
  }
}
