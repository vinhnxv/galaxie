// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './zod-config.js';
import { createRoot } from 'react-dom/client';
import type { Corpus } from '../corpus.js';
import type { RagHost } from './runtime.js';

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
if (import.meta.env.MODE === 'mock') {
  const { createMockModels, mockCorpus } = await import('./mock-script.js');
  corpus = mockCorpus;
  prepareModels = () => createRagHost(retrieval, createMockModels());
} else {
  try {
    const response = await fetch('/data/squad-dev.json', {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) corpus = parseCorpus(await response.json());
  } catch {}
  prepareModels = async () => createRagHost(retrieval, await prepareRealModels());
}
const startIndex = (): Promise<unknown> =>
  retrieval.init({
    appId: 'rag-browser',
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
    />,
  );
void startIndex().catch(() => {});
addEventListener('pagehide', (event) => {
  if (!event.persisted) retrieval.dispose();
});
