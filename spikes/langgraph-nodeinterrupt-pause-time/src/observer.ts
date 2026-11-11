// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { isGraphInterrupt } from '@langchain/langgraph';
import { marked } from './candidates.js';

export class Observer extends BaseCallbackHandler {
  override name = 'spike-interrupt-observer';
  override awaitHandlers = true;
  readonly errors: Error[] = [];

  override handleChainError(error: Error): void {
    if (isGraphInterrupt(error)) this.errors.push(error);
  }

  records(chunks: readonly unknown[]): unknown[] {
    const streamed = chunks.flatMap((chunk) =>
      typeof chunk === 'object' && chunk !== null && '__interrupt__' in chunk
        ? (chunk.__interrupt__ as unknown[])
        : [],
    );
    return this.errors.map((error) => ({
      name: error.name,
      marked: marked(error),
      interrupts: isGraphInterrupt(error)
        ? error.interrupts.map((pending) => ({
            ownId: Object.hasOwn(pending, 'id'),
            keys: Object.keys(pending),
            marked: marked(pending),
            sameAsStream: streamed.includes(pending),
          }))
        : [],
    }));
  }
}
