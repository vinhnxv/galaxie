// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// M0 smoke test (throwaway, brief §16.2): load LFM3-1.7B-ONNX (q4f16) with onnxruntime-web on
// WebGPU and generate text. The result object is also exposed as `window.__b0`.

import { Template } from '@huggingface/jinja';
import { Tokenizer } from '@huggingface/tokenizers';
import * as ort from 'onnxruntime-web/webgpu';

const REPO = 'LiquidAI/LFM3-1.7B-ONNX';
const REVISION = '189271ef61b9e7fdd4a8b5b0891bcacad37700f8';
const CACHE_NAME = `b0-lfm3-1.7b-${REVISION.slice(0, 12)}`;

// Sizes and hashes from the Hub's file listing at REVISION: SHA-256 for Git LFS files, the git
// blob SHA-1 for the others.
const FILES = {
  config: {
    path: 'config.json',
    size: 1_657,
    gitSha1: 'f2e21096218e68743764ae76d8f3ab56a300eaa5',
  },
  tokenizerConfig: {
    path: 'tokenizer_config.json',
    size: 14_574,
    gitSha1: 'fcba47091d2e196f5ce136f1c2705635b088d385',
  },
  chatTemplate: {
    path: 'chat_template.jinja',
    size: 12_129,
    gitSha1: 'd0747b8b5fc99eaecfe02a04eefcff75eb181334',
  },
  tokenizer: {
    path: 'tokenizer.json',
    size: 17_908_634,
    sha256: '41927bd314d17d7d7fadb44e10cd0919f7b71528d7741596d8cbd15c6945ec44',
  },
  graph: {
    path: 'onnx/model_q4f16.onnx',
    size: 268_082,
    sha256: '92cfb8854f0bb27e308f0f5b0106de9c4149505ad2e929b2676d6d89541884e5',
  },
  weights: {
    path: 'onnx/model_q4f16.onnx_data',
    size: 1_382_930_432,
    sha256: 'd8c39dc3ebeeaa00ad016d42112e97b7c6131cb255eb2755ea1d05d05ffa73dd',
  },
};

// From the model card: on WebGPU, prefill in chunks of at most 256 tokens; repetition penalty 1.1.
const PREFILL_CHUNK = 256;
const REPETITION_PENALTY = 1.1;
const MAX_NEW_TOKENS = 128;
// The first prompt also pays for shader compilation; the second one runs warm.
const PROMPTS = [
  'In two sentences, explain what WebGPU lets a web page do.',
  'Hãy giới thiệu ngắn gọn về Hà Nội trong hai câu.',
];

const result = {
  status: 'idle',
  model: { repo: REPO, revision: REVISION },
  files: {},
  runs: [],
  errors: [],
};
window.__b0 = result;

const byId = (id) => document.getElementById(id);
const pageStart = performance.now();
const elapsedMs = (since) => Math.round(performance.now() - since);
const text = (bytes) => new TextDecoder().decode(bytes);

function log(message) {
  byId('log').textContent +=
    `[${((performance.now() - pageStart) / 1000).toFixed(1)} s] ${message}\n`;
}

function setStatus(status, detail) {
  result.status = status;
  byId('status').textContent = detail ? `${status}: ${detail}` : status;
}

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

async function hashMatches(bytes, file) {
  if (file.sha256) {
    return toHex(await crypto.subtle.digest('SHA-256', bytes)) === file.sha256;
  }
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const blob = new Uint8Array(header.byteLength + bytes.byteLength);
  blob.set(header);
  blob.set(bytes, header.byteLength);
  return toHex(await crypto.subtle.digest('SHA-1', blob)) === file.gitSha1;
}

// Returns the file's bytes from Cache Storage, downloading it first if needed, and checks them
// against the pinned size and hash. A file that fails the check is removed from the cache.
async function load(name) {
  const file = FILES[name];
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.path}`;
  const record = { path: file.path, bytes: file.size, fromCache: true };
  result.files[name] = record;
  const cache = await caches.open(CACHE_NAME);
  const start = performance.now();
  let cached = await cache.match(url);
  if (!cached) {
    record.fromCache = false;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`GET ${file.path}: HTTP ${response.status}`);
    }
    let received = 0;
    let reportedAt = 0;
    const counted = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          received += chunk.byteLength;
          if (performance.now() - reportedAt > 1000) {
            reportedAt = performance.now();
            const mb = (n) => (n / 1e6).toFixed(0);
            setStatus('downloading', `${file.path} ${mb(received)} / ${mb(file.size)} MB`);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    await cache.put(url, new Response(counted));
    record.downloadMs = elapsedMs(start);
    cached = await cache.match(url);
  }
  const bytes = new Uint8Array(await cached.arrayBuffer());
  record.readyMs = elapsedMs(start);
  const verifyStart = performance.now();
  const valid = bytes.byteLength === file.size && (await hashMatches(bytes, file));
  record.verifyMs = elapsedMs(verifyStart);
  if (!valid) {
    await cache.delete(url);
    throw new Error(`${file.path}: size or hash does not match revision ${REVISION}`);
  }
  log(
    `${file.path}: ${record.fromCache ? 'read from cache' : 'downloaded'}, ` +
      `${(file.size / 1e6).toFixed(1)} MB in ${record.readyMs} ms, hash checked in ${record.verifyMs} ms`,
  );
  return bytes;
}

async function describeEnvironment() {
  const hints = await navigator.userAgentData?.getHighEntropyValues([
    'architecture',
    'fullVersionList',
    'platformVersion',
  ]);
  result.browser = {
    userAgent: navigator.userAgent,
    fullVersionList: hints?.fullVersionList,
    platformVersion: hints?.platformVersion,
    architecture: hints?.architecture,
  };
  if (!navigator.gpu) {
    throw new Error('navigator.gpu is missing: WebGPU is not available on this page');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('navigator.gpu.requestAdapter() returned null');
  }
  const { vendor, architecture, device, description } = adapter.info ?? {};
  result.gpu = {
    vendor,
    architecture,
    device,
    description,
    shaderF16: adapter.features.has('shader-f16'),
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  };
  log(`GPU adapter: ${vendor} ${architecture}; shader-f16: ${result.gpu.shaderF16}`);
  return adapter;
}

function zeros(type, length) {
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
function emptyPast(session) {
  const past = {};
  for (const meta of session.inputMetadata) {
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

const int64 = (values, dims) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), dims);

function disposeGpuTensors(tensors) {
  for (const tensor of Object.values(tensors)) {
    if (tensor.location === 'gpu-buffer') {
      tensor.dispose();
    }
  }
}

function halfToFloat(bits) {
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
function toFloat32(data) {
  if (data instanceof Float32Array) {
    return data.slice();
  }
  if (data instanceof Uint16Array) {
    return Float32Array.from(data, halfToFloat);
  }
  return Float32Array.from(data);
}

// Runs one forward pass over `ids`, keeps the new caches on the GPU for the next step, and returns
// the logits for the last position.
async function step(model, state, ids) {
  const total = state.pastLength + ids.length;
  const feeds = {
    input_ids: int64(ids, [1, ids.length]),
    attention_mask: int64(new Array(total).fill(1), [1, total]),
    position_ids: int64(
      ids.map((_, i) => state.pastLength + i),
      [1, ids.length],
    ),
    logits_to_keep: int64([1], model.logitsToKeepDims),
    ...state.past,
  };
  const missing = model.session.inputNames.filter((name) => !(name in feeds));
  if (missing.length > 0) {
    throw new Error(`no value for graph inputs: ${missing.join(', ')}`);
  }
  const outputs = await model.session.run(
    Object.fromEntries(model.session.inputNames.map((name) => [name, feeds[name]])),
  );
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
  const { logits } = outputs;
  const [, rows, vocab] = logits.dims;
  const data = await logits.getData(logits.location !== 'cpu');
  return toFloat32(data.subarray((rows - 1) * vocab, rows * vocab));
}

// Greedy choice after the repetition penalty on every token seen so far.
function pickNext(logits, seen) {
  for (const id of seen) {
    logits[id] = logits[id] > 0 ? logits[id] / REPETITION_PENALTY : logits[id] * REPETITION_PENALTY;
  }
  let best = 0;
  for (let i = 1; i < logits.length; i++) {
    if (logits[i] > logits[best]) {
      best = i;
    }
  }
  return best;
}

async function generate(model, prompt) {
  const rendered = model.template.render({
    messages: [{ role: 'user', content: prompt }],
    bos_token: model.bosToken,
    add_generation_prompt: true,
    enable_thinking: false,
  });
  const promptIds = model.tokenizer.encode(rendered, { add_special_tokens: false }).ids;
  // Keep the whole sequence inside one sliding window, so the output does not depend on how the
  // graph trims the sliding-window attention caches.
  if (promptIds.length + MAX_NEW_TOKENS > model.slidingWindow) {
    throw new Error(
      `${promptIds.length} prompt tokens plus ${MAX_NEW_TOKENS} new tokens exceed the ` +
        `sliding window of ${model.slidingWindow}`,
    );
  }
  const state = { past: emptyPast(model.session), pastLength: 0 };
  const seen = new Set(promptIds);
  const start = performance.now();
  let logits;
  for (let offset = 0; offset < promptIds.length; offset += PREFILL_CHUNK) {
    logits = await step(model, state, promptIds.slice(offset, offset + PREFILL_CHUNK));
  }
  let next = pickNext(logits, seen);
  const firstTokenAt = performance.now();
  const generated = [next];
  while (next !== model.eosId && generated.length < MAX_NEW_TOKENS) {
    seen.add(next);
    next = pickNext(await step(model, state, [next]), seen);
    generated.push(next);
  }
  const decodeSeconds = (performance.now() - firstTokenAt) / 1000;
  disposeGpuTensors(state.past);
  return {
    prompt,
    promptTokens: promptIds.length,
    promptTokenIds: promptIds,
    newTokens: generated.length,
    stoppedAtEos: next === model.eosId,
    timeToFirstTokenMs: Math.round(firstTokenAt - start),
    decodeTokensPerSecond:
      generated.length > 1 ? Number(((generated.length - 1) / decodeSeconds).toFixed(1)) : null,
    text: model.tokenizer.decode(generated, { skip_special_tokens: true }),
  };
}

const describeValue = (meta) =>
  meta.isTensor
    ? `${meta.name}: ${meta.type} [${meta.shape.join(', ')}]`
    : `${meta.name}: non-tensor`;

async function run() {
  byId('run').disabled = true;
  result.runs = [];
  result.errors = [];
  try {
    setStatus('checking WebGPU');
    const adapter = await describeEnvironment();

    setStatus('loading files');
    const filesStart = performance.now();
    const config = JSON.parse(text(await load('config')));
    const tokenizerConfig = JSON.parse(text(await load('tokenizerConfig')));
    const template = new Template(text(await load('chatTemplate')));
    const tokenizer = new Tokenizer(JSON.parse(text(await load('tokenizer'))), tokenizerConfig);
    const graph = await load('graph');
    const weights = await load('weights');
    result.filesReadyMs = elapsedMs(filesStart);

    setStatus('creating the session');
    ort.env.wasm.numThreads = 1; // the page is not cross-origin isolated
    ort.env.webgpu.adapter = adapter; // the adapter that result.gpu describes
    result.runtime = { onnxruntimeWeb: ort.env.versions?.web, wasmThreads: 1 };
    const sessionStart = performance.now();
    const session = await ort.InferenceSession.create(graph, {
      executionProviders: ['webgpu'],
      externalData: [{ path: 'model_q4f16.onnx_data', data: weights }],
      preferredOutputLocation: 'gpu-buffer',
    });
    result.sessionCreateMs = elapsedMs(sessionStart);
    result.io = {
      inputs: session.inputMetadata.map(describeValue),
      outputs: session.outputMetadata.map(describeValue),
    };
    log(`session created in ${result.sessionCreateMs} ms`);

    const logitsToKeep = session.inputMetadata.find((meta) => meta.name === 'logits_to_keep');
    const model = {
      session,
      tokenizer,
      template,
      bosToken: tokenizerConfig.bos_token,
      eosId: config.eos_token_id,
      slidingWindow: config.sliding_window,
      logitsToKeepDims: logitsToKeep?.shape.length ? [1] : [],
    };
    for (const prompt of PROMPTS) {
      setStatus('generating', prompt);
      const outcome = await generate(model, prompt);
      result.runs.push(outcome);
      log(
        `${outcome.promptTokens} prompt tokens, ${outcome.newTokens} new tokens, ` +
          `TTFT ${outcome.timeToFirstTokenMs} ms, decode ${outcome.decodeTokensPerSecond} tok/s`,
      );
    }
    const { usage, quota } = await navigator.storage.estimate();
    result.storage = { usageMB: Math.round(usage / 1e6), quotaMB: Math.round(quota / 1e6) };
    setStatus('done');
  } catch (error) {
    result.errors.push(String(error?.stack ?? error));
    log(`ERROR: ${error?.message ?? error}`);
    setStatus('failed', String(error?.message ?? error));
  } finally {
    byId('result').textContent = JSON.stringify(result, null, 2);
    byId('run').disabled = false;
  }
}

byId('run').addEventListener('click', run);
if (new URLSearchParams(location.search).has('autorun')) {
  run();
}
