// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  GalaxieError,
  type InteractionRequest,
  parseInteractionRequest,
  type Submission,
} from '@galaxie/core';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { interrupt, type LangGraphRunnableConfig } from '@langchain/langgraph/web';

/** Synchronous scope only; async nodes must pass config to requestInteraction. */
export class SynchronousContext {
  private store: unknown;

  getStore(): unknown {
    return this.store;
  }

  run<T>(store: unknown, callback: () => T): T {
    const previous = this.store;
    this.store = store;
    try {
      return callback();
    } finally {
      this.store = previous;
    }
  }

  enterWith(store: unknown): void {
    this.store = store;
  }
}

export function installContext(): void {
  AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new SynchronousContext());
}

/** Pass the node's config explicitly, including after an await. */
export function requestInteraction(value: unknown, config: LangGraphRunnableConfig): Submission {
  const request = parseInteractionRequest(value);
  if (request === undefined)
    throw new GalaxieError('invalid', 'The interaction request is invalid.');
  return AsyncLocalStorageProviderSingleton.runWithConfig(config, () =>
    interrupt<InteractionRequest, Submission>(request),
  );
}
