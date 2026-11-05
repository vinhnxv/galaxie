// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The inference worker: loads LFM3-1.7B-ONNX (q4f16) with onnxruntime-web on WebGPU and runs one
// generation at a time, in the order the page asks. The session setup and the generation loop come
// from spikes/b0-webgpu-load; this version also streams text, honours aborts, accepts sequences
// longer than one 256-token prefill chunk, and can guide a reply to match a JSON schema.

import { Template } from '@huggingface/jinja';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/webgpu';
import { CANDIDATES, type Decoder, writeJson } from './json-guide.js';
import { loadFile, type ModelFile } from './model-files.js';
import type {
  ChatTurn,
  EngineInfo,
  FromWorker,
  GenerateRequest,
  GenerationStats,
  JsonSchema,
  LoadProgress,
  ToWorker,
} from './protocol.js';

// From the model card: on WebGPU, prefill at most 256 tokens per pass; repetition penalty 1.1.
const PREFILL_CHUNK = 256;
const REPETITION_PENALTY = 1.1;

interface Model {
  readonly session: ort.InferenceSession;
  readonly tokenizer: Tokenizer;
  readonly template: Template;
  readonly bosToken: string;
  readonly eosId: number;
  readonly logitsToKeepDims: readonly number[];
}

type Feeds = Record<string, ort.Tensor>;

interface DecodeState {
  past: Feeds;
  pastLength: number;
}

const post = (message: FromWorker): void => self.postMessage(message);
const elapsedMs = (since: number): number => Math.round(performance.now() - since);
const utf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

let model: Promise<Model> | undefined;
let queue: Promise<void> = Promise.resolve();
const aborted = new Set<number>();

self.onmessage = (event: MessageEvent<ToWorker>): void => {
  const message = event.data;
  switch (message.type) {
    case 'load':
      ensureModel().then(
        () => undefined,
        () => undefined,
      );
      break;
    case 'abort':
      aborted.add(message.id);
      break;
    case 'generate':
      queue = queue.then(() => runRequest(message.id, message.request));
      break;
  }
};

function ensureModel(): Promise<Model> {
  model ??= loadModel().then(
    (loaded) => loaded,
    (error: unknown) => {
      model = undefined;
      post({ type: 'load-failed', message: messageOf(error) });
      throw error;
    },
  );
  return model;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const progress = (value: LoadProgress): void => post({ type: 'progress', progress: value });

async function loadModel(): Promise<Model> {
  progress({ stage: 'checking-gpu' });
  const gpu = navigator.gpu;
  if (gpu === undefined) {
    throw new Error('WebGPU is not available in this worker');
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) {
    throw new Error('navigator.gpu.requestAdapter() returned null');
  }

  const filesStart = performance.now();
  const downloadedFiles: string[] = [];
  const load = async (name: ModelFile): Promise<Uint8Array<ArrayBuffer>> => {
    const { bytes, downloaded } = await loadFile(name, (loadedBytes, totalBytes) =>
      progress({ stage: 'loading-files', file: name, loadedBytes, totalBytes }),
    );
    if (downloaded) {
      downloadedFiles.push(name);
    }
    return bytes;
  };
  const config = JSON.parse(utf8(await load('config'))) as { eos_token_id: number };
  const tokenizerConfig = JSON.parse(utf8(await load('tokenizerConfig'))) as {
    bos_token: string;
  };
  const template = new Template(utf8(await load('chatTemplate')));
  const tokenizer = new Tokenizer(JSON.parse(utf8(await load('tokenizer'))), tokenizerConfig);
  const graph = await load('graph');
  const weights = await load('weights');
  const filesReadyMs = elapsedMs(filesStart);

  progress({ stage: 'creating-session' });
  ort.env.wasm.numThreads = 1; // the page is not cross-origin isolated
  ort.env.webgpu.adapter = adapter;
  const sessionStart = performance.now();
  const session = await ort.InferenceSession.create(graph, {
    executionProviders: ['webgpu'],
    externalData: [{ path: 'model_q4f16.onnx_data', data: weights }],
    preferredOutputLocation: 'gpu-buffer',
  });
  const sessionCreateMs = elapsedMs(sessionStart);

  const logitsToKeep = tensorInputs(session).find((meta) => meta.name === 'logits_to_keep');
  const info: EngineInfo = {
    gpu: `${adapter.info.vendor} ${adapter.info.architecture}`.trim(),
    shaderF16: adapter.features.has('shader-f16'),
    onnxruntimeWeb: ort.env.versions.web,
    downloadedFiles,
    filesReadyMs,
    sessionCreateMs,
  };
  post({ type: 'ready', info });
  return {
    session,
    tokenizer,
    template,
    bosToken: tokenizerConfig.bos_token,
    eosId: config.eos_token_id,
    logitsToKeepDims: logitsToKeep !== undefined && logitsToKeep.shape.length > 0 ? [1] : [],
  };
}

interface TensorInput {
  readonly name: string;
  readonly type: ort.Tensor.Type;
  readonly shape: readonly (number | string)[];
}

function tensorInputs(session: ort.InferenceSession): TensorInput[] {
  return session.inputMetadata.flatMap((meta) =>
    meta.isTensor ? [{ name: meta.name, type: meta.type, shape: meta.shape }] : [],
  );
}

async function runRequest(id: number, request: GenerateRequest): Promise<void> {
  try {
    const loaded = await ensureModel();
    const { text, stats } =
      request.jsonSchema === undefined
        ? await generate(loaded, id, request)
        : await generateGuided(loaded, id, request, request.jsonSchema);
    post({ type: 'done', id, text, stats });
  } catch (error) {
    post({ type: 'failed', id, message: messageOf(error) });
  } finally {
    aborted.delete(id);
  }
}

function zeros(type: ort.Tensor.Type, length: number): Uint16Array | Float32Array | BigInt64Array {
  switch (type) {
    case 'float16':
      return new Uint16Array(length);
    case 'float32':
      return new Float32Array(length);
    case 'int64':
      return new BigInt64Array(length);
    default:
      throw new Error(`no zero-filled array for type ${type}`);
  }
}

// Caches for the first step, shaped from the graph's input metadata: batch 1 and no past tokens.
// Only the attention caches have a past-length axis; the conv states have fixed sizes.
function emptyPast(session: ort.InferenceSession): Feeds {
  const past: Feeds = {};
  for (const meta of tensorInputs(session)) {
    if (!meta.name.startsWith('past_')) {
      continue;
    }
    const dims = meta.shape.map((dim, axis) => {
      if (typeof dim === 'number') {
        return dim;
      }
      if (axis === 0) {
        return 1;
      }
      if (meta.name.startsWith('past_key_values.')) {
        return 0;
      }
      throw new Error(`${meta.name}: unexpected symbolic dimension ${dim} at axis ${axis}`);
    });
    const length = dims.reduce((product, dim) => product * dim, 1);
    past[meta.name] = new ort.Tensor(meta.type, zeros(meta.type, length), dims);
  }
  return past;
}

const int64 = (values: readonly number[], dims: readonly number[]): ort.Tensor =>
  new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);

function disposeGpuTensors(tensors: Feeds): void {
  for (const tensor of Object.values(tensors)) {
    if (tensor.location === 'gpu-buffer') {
      tensor.dispose();
    }
  }
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) {
    return sign * 2 ** -14 * (fraction / 1024);
  }
  if (exponent === 31) {
    return fraction ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  }
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

// Logits come back as float32, or as float16 in a Uint16Array or a Float16Array.
function toFloat32(data: ort.Tensor.DataType): Float32Array {
  if (data instanceof Float32Array) {
    return data.slice();
  }
  if (data instanceof Uint16Array) {
    return Float32Array.from(data, halfToFloat);
  }
  return Float32Array.from(data as ArrayLike<number>);
}

// Runs one forward pass over `ids`, keeps the new caches on the GPU for the next step, and returns
// the logits for the last position. The attention mask covers the whole sequence; the graph applies
// the sliding window itself, as Transformers.js 4.3.2 assumes for LFM3.
async function step(
  model: Model,
  state: DecodeState,
  ids: readonly number[],
): Promise<Float32Array> {
  const total = state.pastLength + ids.length;
  const feeds: Feeds = {
    input_ids: int64(ids, [1, ids.length]),
    attention_mask: int64(new Array<number>(total).fill(1), [1, total]),
    position_ids: int64(
      ids.map((_, i) => state.pastLength + i),
      [1, ids.length],
    ),
    logits_to_keep: int64([1], model.logitsToKeepDims),
    ...state.past,
  };
  const inputs: Feeds = {};
  for (const name of model.session.inputNames) {
    const tensor = feeds[name];
    if (tensor === undefined) {
      throw new Error(`no value for graph input ${name}`);
    }
    inputs[name] = tensor;
  }
  const outputs = await model.session.run(inputs);
  disposeGpuTensors(state.past);
  state.past = {};
  for (const [name, tensor] of Object.entries(outputs)) {
    if (name !== 'logits') {
      const pastName = name
        .replace(/^present_conv\./, 'past_conv.')
        .replace(/^present\./, 'past_key_values.');
      state.past[pastName] = tensor;
    }
  }
  state.pastLength = total;
  const logits = outputs['logits'];
  if (logits === undefined) {
    throw new Error('the graph returned no logits');
  }
  const [, rows = 1, vocab = 0] = logits.dims;
  // Logits are float32 or float16, never strings.
  const data = (await logits.getData(logits.location !== 'cpu')) as Exclude<
    ort.Tensor.DataType,
    string[]
  >;
  return toFloat32(data.subarray((rows - 1) * vocab, rows * vocab));
}

function penalize(logits: Float32Array, seen: ReadonlySet<number>): void {
  for (const id of seen) {
    const value = logits[id] ?? 0;
    logits[id] = value > 0 ? value / REPETITION_PENALTY : value * REPETITION_PENALTY;
  }
}

// Greedy choice after the repetition penalty on every token seen so far, prompt included.
function pickNext(logits: Float32Array, seen: ReadonlySet<number>): number {
  penalize(logits, seen);
  let best = 0;
  for (let i = 1; i < logits.length; i++) {
    if ((logits[i] ?? Number.NEGATIVE_INFINITY) > (logits[best] ?? Number.NEGATIVE_INFINITY)) {
      best = i;
    }
  }
  return best;
}

/** The `count` tokens with the highest scores, best first. */
function topTokens(scores: Float32Array, count: number): number[] {
  const ids: number[] = [];
  const kept: number[] = [];
  for (let id = 0; id < scores.length; id++) {
    const score = scores[id] ?? Number.NEGATIVE_INFINITY;
    if (ids.length === count && score <= (kept[count - 1] ?? Number.NEGATIVE_INFINITY)) {
      continue;
    }
    let at = Math.min(ids.length, count - 1);
    while (at > 0 && (kept[at - 1] ?? Number.NEGATIVE_INFINITY) < score) {
      kept[at] = kept[at - 1] ?? Number.NEGATIVE_INFINITY;
      ids[at] = ids[at - 1] ?? 0;
      at--;
    }
    kept[at] = score;
    ids[at] = id;
  }
  return ids;
}

// Turns generated tokens into text deltas that never split a character or a word: text is released
// up to the last space, or entirely at a newline, the way Transformers' TextStreamer does it.
class TextEmitter {
  readonly #tokenizer: Tokenizer;
  readonly #emit: (delta: string) => void;
  #ids: number[] = [];
  #printed = 0;

  constructor(tokenizer: Tokenizer, emit: (delta: string) => void) {
    this.#tokenizer = tokenizer;
    this.#emit = emit;
  }

  push(id: number): void {
    this.#ids.push(id);
    const text = this.#tokenizer.decode(this.#ids, { skip_special_tokens: true });
    if (text.endsWith('\n')) {
      this.#release(text.slice(this.#printed));
      this.#ids = [];
      this.#printed = 0;
      return;
    }
    const end = text.lastIndexOf(' ') + 1;
    if (end > this.#printed) {
      this.#release(text.slice(this.#printed, end));
      this.#printed = end;
    }
  }

  flush(): void {
    // The tokenizer refuses to decode an empty list.
    if (this.#ids.length === 0) {
      return;
    }
    const text = this.#tokenizer.decode(this.#ids, { skip_special_tokens: true });
    this.#release(text.slice(this.#printed));
    this.#ids = [];
    this.#printed = 0;
  }

  #release(delta: string): void {
    if (delta !== '') {
      this.#emit(delta);
    }
  }
}

function encodePrompt(model: Model, messages: readonly ChatTurn[]): number[] {
  const rendered = model.template.render({
    messages,
    bos_token: model.bosToken,
    add_generation_prompt: true,
    enable_thinking: false,
  });
  return model.tokenizer.encode(rendered, { add_special_tokens: false }).ids;
}

async function generate(
  model: Model,
  id: number,
  request: GenerateRequest,
): Promise<{ text: string; stats: GenerationStats }> {
  const start = performance.now();
  const promptIds = encodePrompt(model, request.messages);
  const seen = new Set(promptIds);
  const generated: number[] = [];
  const emitter = new TextEmitter(model.tokenizer, (delta) => post({ type: 'text', id, delta }));
  const state: DecodeState = { past: emptyPast(model.session), pastLength: 0 };
  let stoppedAtEos = false;
  let firstTokenAt = Number.NaN;
  try {
    let logits: Float32Array | undefined;
    for (let offset = 0; offset < promptIds.length && !aborted.has(id); offset += PREFILL_CHUNK) {
      logits = await step(model, state, promptIds.slice(offset, offset + PREFILL_CHUNK));
    }
    if (logits !== undefined && !aborted.has(id)) {
      let next = pickNext(logits, seen);
      firstTokenAt = performance.now();
      while (true) {
        if (next === model.eosId) {
          stoppedAtEos = true;
          break;
        }
        generated.push(next);
        seen.add(next);
        emitter.push(next);
        if (generated.length >= request.maxNewTokens || aborted.has(id)) {
          break;
        }
        next = pickNext(await step(model, state, [next]), seen);
      }
    }
  } finally {
    disposeGpuTensors(state.past);
  }
  emitter.flush();
  const decodeSeconds = (performance.now() - firstTokenAt) / 1000;
  return {
    text:
      generated.length === 0
        ? ''
        : model.tokenizer.decode(generated, { skip_special_tokens: true }),
    stats: {
      promptTokens: promptIds.length,
      newTokens: generated.length,
      stoppedAtEos,
      aborted: aborted.has(id),
      timeToFirstTokenMs: Number.isNaN(firstTokenAt) ? -1 : Math.round(firstTokenAt - start),
      totalMs: elapsedMs(start),
      decodeTokensPerSecond:
        generated.length > 1 ? Number(((generated.length - 1) / decodeSeconds).toFixed(1)) : null,
    },
  };
}

const tokenTexts = new Map<number, string>();

/** A token's text on its own, or '' for a special token. */
function tokenText(model: Model, token: number): string {
  let text = tokenTexts.get(token);
  if (text === undefined) {
    text = model.tokenizer.decode([token], { skip_special_tokens: true });
    tokenTexts.set(token, text);
  }
  return text;
}

/** Ends a guided generation early: on abort, or at the request's token limit. */
class GenerationStopped extends Error {}

// Guided generation (json-guide.ts) on the same forward pass as generate(). The model reads the text
// the guide writes in one pass before its next choice, so a run of structure costs one pass, not one
// pass per token.
async function generateGuided(
  model: Model,
  id: number,
  request: GenerateRequest,
  schema: JsonSchema,
): Promise<{ text: string; stats: GenerationStats }> {
  const start = performance.now();
  const promptIds = encodePrompt(model, request.messages);
  const encode = (text: string): number[] =>
    model.tokenizer.encode(text, { add_special_tokens: false }).ids;
  // The repetition penalty leaves out tokens with a quote, so that it does not keep the model from
  // ending a string.
  const penalized = (token: number): boolean => {
    const text = tokenText(model, token);
    return text !== '' && !text.includes('"');
  };
  const seen = new Set(promptIds.filter(penalized));
  let reply = '';
  const emit = (delta: string): void => {
    reply += delta;
    post({ type: 'text', id, delta });
  };
  const emitter = new TextEmitter(model.tokenizer, emit);
  const state: DecodeState = { past: emptyPast(model.session), pastLength: 0 };
  // Tokens in the sequence that the model has not read yet, and text the guide wrote since then.
  let unread = [...promptIds];
  let written = '';
  let forcedTokens = 0;
  let chosenTokens = 0;
  let firstTokenAt = Number.NaN;
  const encodeWritten = (): void => {
    if (written !== '') {
      const ids = encode(written);
      forcedTokens += ids.length;
      unread.push(...ids);
      written = '';
    }
  };
  const decoder: Decoder = {
    write(text) {
      emitter.flush();
      emit(text);
      written += text;
    },
    accept(token) {
      encodeWritten();
      unread.push(token);
      if (penalized(token)) {
        seen.add(token);
      }
      chosenTokens++;
      emitter.push(token);
    },
    async next() {
      encodeWritten();
      if (aborted.has(id) || forcedTokens + chosenTokens >= request.maxNewTokens) {
        throw new GenerationStopped();
      }
      let logits: Float32Array | undefined;
      for (let offset = 0; offset < unread.length; offset += PREFILL_CHUNK) {
        logits = await step(model, state, unread.slice(offset, offset + PREFILL_CHUNK));
      }
      unread = [];
      if (logits === undefined) {
        throw new Error('the model has nothing new to read');
      }
      if (Number.isNaN(firstTokenAt)) {
        firstTokenAt = performance.now();
      }
      penalize(logits, seen);
      const scores = logits;
      return {
        ranked: topTokens(scores, CANDIDATES),
        score: (token) => scores[token] ?? Number.NEGATIVE_INFINITY,
      };
    },
    textOf: (token) => tokenText(model, token),
    encode,
    eosId: model.eosId,
  };
  try {
    await writeJson(schema, decoder);
  } catch (error) {
    if (!(error instanceof GenerationStopped)) {
      throw error;
    }
  } finally {
    disposeGpuTensors(state.past);
  }
  emitter.flush();
  encodeWritten(); // counts the closing text, which the model never needs to read
  const newTokens = forcedTokens + chosenTokens;
  const decodeSeconds = (performance.now() - firstTokenAt) / 1000;
  return {
    text: reply,
    stats: {
      promptTokens: promptIds.length,
      newTokens,
      forcedTokens,
      stoppedAtEos: false,
      aborted: aborted.has(id),
      timeToFirstTokenMs: Number.isNaN(firstTokenAt) ? -1 : Math.round(firstTokenAt - start),
      totalMs: elapsedMs(start),
      decodeTokensPerSecond:
        newTokens > 1 && decodeSeconds > 0 ? Number((newTokens / decodeSeconds).toFixed(1)) : null,
    },
  };
}
