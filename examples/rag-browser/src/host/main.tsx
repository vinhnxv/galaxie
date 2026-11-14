// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './zod-config.js';
import { createRoot } from 'react-dom/client';
import type { Corpus } from '../corpus.js';
import type { RagHost, RagModels } from './runtime.js';
import { appId, principalScope } from './scope.js';

const [
  { parseCorpus },
  { RetrievalClient },
  { App },
  { createRagHost, prepareRealModels },
  { createRetrievalWorker },
] = await Promise.all([
  import('../corpus.js'),
  import('../retrieval/client.js'),
  import('./app.js'),
  import('./runtime.js'),
  import('./trusted-types.js'),
]);

const retrieval = new RetrievalClient(createRetrievalWorker());
const mock = import.meta.env.MODE === 'mock';
let corpus: Corpus | null = null;
let prepareModels: () => Promise<RagHost>;
let models: RagModels | undefined;
const disposeModels = (): void => {
  models?.dispose?.();
  models = undefined;
};
if (import.meta.env.MODE === 'mock') {
  const { createMockModels, mockCorpus } = await import('./mock-script.js');
  corpus = mockCorpus;
  prepareModels = () => {
    models ??= createMockModels();
    return createRagHost(retrieval, models);
  };
} else {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}data/squad-dev.json`, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      // A stalled response must not hold the first render back.
      signal: AbortSignal.timeout(15000),
    });
    if (response.ok) corpus = parseCorpus(await response.json());
  } catch {}
  prepareModels = async () => {
    models ??= await prepareRealModels();
    return createRagHost(retrieval, models);
  };
}
const startIndex = (): Promise<unknown> =>
  retrieval.init({
    appId,
    principalScope,
    mock,
    ...(mock ? { corpus } : { corpusUrl: '/data/squad-dev.json' as const }),
  });
const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    <App
      retrieval={retrieval}
      corpus={corpus}
      startIndex={startIndex}
      prepareModels={prepareModels}
      disposeModels={disposeModels}
    />,
  );
void startIndex().catch(() => {});
addEventListener('pagehide', (event) => {
  if (!event.persisted) retrieval.dispose();
});
