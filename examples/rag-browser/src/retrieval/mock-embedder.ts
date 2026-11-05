// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Embedder, normalize } from './embedder.js';
import { tokenize } from './index.js';
import { embeddingSettings } from './settings.js';

export function createMockEmbedder(): Embedder {
  return {
    device: 'mock',
    async embed(texts) {
      return texts.map((text) => {
        const vector = Array<number>(embeddingSettings.dimensions).fill(0);
        for (const token of tokenize(text)) {
          let hash = 2166136261;
          for (const character of token) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
          const index = (hash >>> 0) % vector.length;
          vector[index] = (vector[index] ?? 0) + 1;
        }
        if (Math.hypot(...vector) === 0) vector[0] = 1;
        return normalize(vector);
      });
    },
    async dispose() {},
  };
}
