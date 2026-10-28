// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Minimal local declarations: the Prompt API has no stable TypeScript DOM declarations.
export interface LanguageOptions {
  expectedInputs: { type: 'text'; languages: string[] }[];
  expectedOutputs: { type: 'text'; languages: string[] }[];
}
export interface PromptSession {
  promptStreaming(
    messages: import('./arms/types.js').Message[],
    options: { signal: AbortSignal; responseConstraint?: import('./arms/types.js').JsonSchema },
  ): ReadableStream<string>;
  destroy(): void;
}
export interface PromptApi {
  availability(options: LanguageOptions): Promise<string>;
  create(
    options: LanguageOptions & { monitor?: (monitor: EventTarget) => void },
  ): Promise<PromptSession>;
}
export function promptApi(): PromptApi | undefined {
  return (globalThis as unknown as { LanguageModel?: PromptApi }).LanguageModel;
}
export function languages(language: string): LanguageOptions {
  return {
    expectedInputs: [{ type: 'text', languages: [language] }],
    expectedOutputs: [{ type: 'text', languages: [language] }],
  };
}
export interface GpuAdapter {
  features: Set<string>;
  info?: { vendor?: string; architecture?: string; description?: string };
}
export async function adapter(): Promise<GpuAdapter | null> {
  try {
    return (
      (await (
        navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }
      ).gpu?.requestAdapter()) ?? null
    );
  } catch {
    return null;
  }
}
export async function gpuProbe(): Promise<import('./arms/types.js').Availability> {
  const gpu = await adapter();
  if (!gpu) return { status: 'unavailable', reason: 'no_webgpu_adapter' };
  if (!gpu.features.has('shader-f16')) return { status: 'unavailable', reason: 'no_shader_f16' };
  return { status: 'downloadable' };
}
export async function promptAvailability(): Promise<{
  en: string;
  vi: string;
  reason: string | null;
}> {
  const api = promptApi();
  if (!api) return { en: 'unavailable', vi: 'unavailable', reason: 'api_missing' };
  const probe = async (language: string): Promise<string> => {
    try {
      return await api.availability(languages(language));
    } catch {
      return 'unavailable';
    }
  };
  return { en: await probe('en'), vi: await probe('vi'), reason: null };
}
export async function deviceInfo(): Promise<{
  userAgent: string;
  chromeVersion: string | null;
  logicalCores: number;
  webgpu: {
    adapter: {
      vendor: string;
      architecture: string;
      description: string;
      shaderF16: boolean;
    } | null;
  };
}> {
  const gpu = await adapter();
  return {
    userAgent: navigator.userAgent,
    chromeVersion: /(?:Chrome|Chromium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null,
    logicalCores: navigator.hardwareConcurrency,
    webgpu: {
      adapter: gpu
        ? {
            vendor: gpu.info?.vendor ?? '',
            architecture: gpu.info?.architecture ?? '',
            description: gpu.info?.description ?? '',
            shaderF16: gpu.features.has('shader-f16'),
          }
        : null,
    },
  };
}
