// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';

export interface ErrorObservation {
  errorClass: string;
  status: number | null;
  credentialFree: boolean;
  exposedFields: string[];
}

const credentials = new Set<string>();

export function registerCredential(value: string): void {
  credentials.add(value);
}

function totalTokens(message: object): number | null {
  const usage: unknown = Reflect.get(message, 'usage_metadata');
  if (typeof usage !== 'object' || usage === null) return null;
  const total: unknown = Reflect.get(usage, 'total_tokens');
  return typeof total === 'number' ? total : null;
}

export function errorObservation(error: unknown): ErrorObservation {
  const exposedFields: string[] = [];
  const seen = new Set<unknown>();
  function inspect(value: unknown, path: string, depth: number): void {
    if (typeof value === 'string') {
      if ([...credentials].some((key) => key.length > 0 && value.includes(key)))
        exposedFields.push(path);
      return;
    }
    if (value === null || typeof value !== 'object' || seen.has(value) || depth > 8) return;
    seen.add(value);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if ('value' in descriptor) inspect(descriptor.value, `${path}.${key}`, depth + 1);
    }
  }
  inspect(error, 'error', 0);
  const record = error as {
    constructor?: { name?: string };
    status?: unknown;
    code?: unknown;
  } | null;
  const status = record?.status ?? record?.code;
  return {
    errorClass: record?.constructor?.name ?? 'Unknown',
    status: typeof status === 'number' ? status : null,
    credentialFree: exposedFields.length === 0,
    exposedFields,
  };
}

export async function token(proxy: string): Promise<string> {
  const response = await fetch(`${proxy}/token`, { method: 'POST', redirect: 'error' });
  if (!response.ok) throw new Error('token_unavailable');
  const result = (await response.json()) as { token: string };
  credentials.add(result.token);
  return result.token;
}

export async function modelProbe(options: {
  baseURL: string;
  key: string;
  model: string;
  action: 'invoke' | 'stream' | 'abort' | 'structured' | 'supplier' | 'default-retry';
  proxy: string;
}): Promise<Record<string, unknown>> {
  const { baseURL, key, model, action, proxy } = options;
  credentials.add(key);
  const supplierAt: number[] = [];
  const started = performance.now();
  const supplier = async (): Promise<string> => {
    supplierAt.push(performance.now() - started);
    return token(proxy);
  };
  const chat = new ChatOpenAI({
    model,
    apiKey: action === 'supplier' || action === 'default-retry' ? supplier : key,
    ...(action === 'default-retry' ? {} : { maxRetries: 0 }),
    configuration: { baseURL, dangerouslyAllowBrowser: true },
  });
  const callsAfterConstruction = supplierAt.length;
  try {
    if (action === 'structured') {
      const schema = z.object({ answer: z.string(), score: z.number() });
      const result = await chat
        .withStructuredOutput(schema, { method: 'jsonSchema', name: 'fixture', strict: true })
        .invoke('Fixture input.');
      return { valid: schema.safeParse(result).success };
    }
    if (action === 'stream' || action === 'abort') {
      const controller = new AbortController();
      let chunks = 0;
      let usage = false;
      let abortAt: number | null = null;
      let observedError: ErrorObservation | null = null;
      try {
        const stream = await chat.stream('Fixture input.', {
          signal: controller.signal,
          stream_options: { include_usage: true },
        });
        for await (const chunk of stream) {
          chunks++;
          if (totalTokens(chunk) === 7) usage = true;
          if (
            action === 'abort' &&
            abortAt === null &&
            typeof chunk.content === 'string' &&
            chunk.content.length > 0
          ) {
            abortAt = Date.now();
            controller.abort();
          }
        }
      } catch (error) {
        observedError = errorObservation(error);
      }
      return {
        chunks,
        usage,
        abortAt,
        error: observedError,
        elapsedMs: performance.now() - started,
      };
    }
    const result = await chat.invoke('Fixture input.');
    if (action === 'supplier') await chat.invoke('Fixture input.');
    return {
      completed: true,
      usage: totalTokens(result),
      supplierAt,
      callsAfterConstruction,
    };
  } catch (error) {
    return {
      completed: false,
      error: errorObservation(error),
      supplierAt,
      callsAfterConstruction,
      elapsedMs: performance.now() - started,
    };
  }
}
