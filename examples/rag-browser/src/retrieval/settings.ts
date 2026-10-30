// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const embeddingSettings: {
  dimensions: number;
  maxTokens: number;
  batchSize: number;
  dtype: 'q4';
  device: 'webgpu';
  queryPrefix: string;
  passagePrefix: string;
} = {
  dimensions: 256,
  maxTokens: 256,
  batchSize: 8,
  dtype: 'q4',
  device: 'webgpu',
  queryPrefix: 'task: search result | query: ',
  passagePrefix: 'title: <title> | text: <text>',
};
export const libraryVersions: { transformers: string; onnxruntime: string; orama: string } = {
  transformers: '4.3.1',
  onnxruntime: '1.31.0-dev.20260914-8d85527a0',
  orama: '3.1.18',
};
export const tokenizerRule: string = '[^\\p{L}\\p{N}]+';
export const schemaVersion: number = 1;
