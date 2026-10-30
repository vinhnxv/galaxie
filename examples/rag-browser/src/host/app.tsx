// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { pythonBuild } from 'virtual:rag-python';
import { ModelRoutes } from '@galaxie/react';
import { type ReactElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type RagOutput, RagOutputSchema, type SearchMode } from '../agent/schemas.js';
import { attribution, type Corpus } from '../corpus.js';
import type { RetrievalClient } from '../retrieval/client.js';
import { type EvaluationRow, evaluate } from './evaluate.js';
import type { RagHost } from './runtime.js';

export interface AppProps {
  retrieval: RetrievalClient;
  corpus: Corpus | null;
  startIndex(): Promise<unknown>;
  prepareModels(): Promise<RagHost>;
  disposeModels(): void;
}
export function App({
  retrieval,
  corpus,
  startIndex,
  prepareModels,
  disposeModels,
}: AppProps): ReactElement {
  const index = useSyncExternalStore(retrieval.subscribe, retrieval.getSnapshot);
  const [host, setHost] = useState<RagHost>();
  const [active, setActive] = useState<RagHost['instance']>();
  const [executor, setExecutor] = useState<'javascript' | 'python'>('javascript');
  const [answerExecutor, setAnswerExecutor] = useState<'javascript' | 'python'>('javascript');
  const [pythonPhase, setPythonPhase] = useState<RagHost['pythonPhase']>('idle');
  const [bootSeconds, setBootSeconds] = useState(0);
  const javascriptOption = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState<SearchMode>('hybrid');
  const [paste, setPaste] = useState('');
  const [answer, setAnswer] = useState<RagOutput>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);
  const [runStatus, setRunStatus] = useState('idle');
  const [evaluating, setEvaluating] = useState(false);
  const [evalProgress, setEvalProgress] = useState('');
  const [rows, setRows] = useState<EvaluationRow[]>([]);
  const controller = useRef<AbortController | undefined>(undefined);
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const busy =
    running ||
    preparing ||
    evaluating ||
    pythonPhase === 'booting' ||
    index.status === 'building' ||
    index.status === 'downloading';
  const reason =
    index.status !== 'ready'
      ? 'Build the index before asking a question.'
      : !host
        ? 'Prepare chat models before asking a question.'
        : '';
  useEffect(() => {
    if (answer) answerHeading.current?.focus();
  }, [answer]);
  useEffect(() => {
    const update = (): void => {
      setActive(host?.instance);
      setExecutor(host?.executor ?? 'javascript');
      setPythonPhase(host?.pythonPhase ?? 'idle');
    };
    update();
    return host?.subscribeExecutor(update);
  }, [host]);
  useEffect(() => {
    const update = (): void => setRunStatus(active?.getSnapshot().run?.status ?? 'idle');
    update();
    return active?.subscribe(update);
  }, [active]);
  useEffect(() => {
    if (host && pythonBuild.available) javascriptOption.current?.focus();
  }, [host]);
  useEffect(() => {
    if (pythonPhase === 'failed' && !busy) javascriptOption.current?.focus();
  }, [pythonPhase, busy]);
  useEffect(() => {
    if (pythonPhase !== 'booting') return;
    const started = performance.now();
    setBootSeconds(0);
    const timer = setInterval(() => setBootSeconds((performance.now() - started) / 1000), 250);
    return () => clearInterval(timer);
  }, [pythonPhase]);
  useEffect(() => {
    const stop = (): void => {
      controller.current?.abort();
      void host?.dispose();
      disposeModels();
      setExecutor('javascript');
    };
    const restorePage = (event: PageTransitionEvent): void => {
      if (event.persisted) window.location.reload();
    };
    addEventListener('pagehide', stop);
    addEventListener('pageshow', restorePage);
    return () => {
      removeEventListener('pagehide', stop);
      removeEventListener('pageshow', restorePage);
    };
  }, [host, disposeModels]);
  const operation = async (action: () => Promise<unknown>, failure: string): Promise<void> => {
    setError(undefined);
    try {
      await action();
    } catch {
      setError(failure);
    }
  };
  const prepare = async (): Promise<void> => {
    setPreparing(true);
    setError(undefined);
    try {
      setHost(await prepareModels());
    } catch {
      disposeModels();
      setError('The chat models could not be prepared.');
    } finally {
      setPreparing(false);
    }
  };
  const ask = async (): Promise<void> => {
    if (!host || running) return;
    setRunning(true);
    setAnswer(undefined);
    setError(undefined);
    setAnswerExecutor(executor);
    try {
      const instance = active ?? host.instance;
      const { runId } = await instance.start({ question, mode });
      for await (const event of instance.events(runId)) {
        if (event.type === 'output') setAnswer(RagOutputSchema.parse(event.output));
        else if (event.type === 'error') setError(event.error.message);
      }
    } catch {
      setError('The question could not be answered.');
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    if (index.status !== 'empty') return;
    controller.current?.abort();
    void host?.dispose();
    disposeModels();
    setHost(undefined);
    setPaste('');
    setQuestion('');
    setAnswer(undefined);
    setRows([]);
    setError(undefined);
    setRunStatus('idle');
  }, [index.status, host, disposeModels]);
  const clear = async (): Promise<void> => {
    await retrieval.clear();
  };
  const runEvaluation = async (): Promise<void> => {
    controller.current = new AbortController();
    setEvaluating(true);
    setError(undefined);
    setRows([]);
    try {
      setRows(
        await evaluate(corpus?.questions ?? [], (input) => retrieval.search(input), {
          signal: controller.current.signal,
          onProgress: (done, total) => setEvalProgress(`${done} of ${total} searches`),
        }),
      );
    } catch {
      if (controller.current.signal.aborted) setEvalProgress('Evaluation cancelled.');
      else setError('Evaluation could not be completed.');
    } finally {
      setEvaluating(false);
    }
  };
  const noMatch = answer !== undefined && host?.getLastSearchCount() === 0;
  return (
    <main>
      <h1>Ask your documents</h1>
      <p>
        Build an index and answer questions in this browser.{' '}
        {executor === 'python' ? 'Python · LangGraph Python' : 'JavaScript · LangGraph.js'}
      </p>
      <section aria-labelledby="index-heading">
        <h2 id="index-heading">Index and models</h2>
        <p role="status">
          {index.status === 'ready'
            ? `${index.restored ? 'Restored' : 'Ready'}: ${index.count} passages (${index.pastedCount} pasted). Device: ${index.device}.`
            : index.status === 'building' || index.status === 'downloading'
              ? `${index.status}: ${index.loaded} of ${index.total}`
              : index.status === 'awaiting-consent'
                ? 'Waiting for embedding download consent.'
                : index.status === 'empty'
                  ? 'The index is empty.'
                  : 'Indexing failed.'}
        </p>
        {index.status === 'awaiting-consent' && (
          <>
            <p>
              EmbeddingGemma 2: 233.6 MB (206.7 MB model files + 26.9 MB ONNX Runtime). WebGPU
              required. Pasted text stays in this browser.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void operation(() => retrieval.consent(), 'Indexing could not be completed.')
              }
            >
              Download embedding model and build index
            </button>
          </>
        )}
        {index.status === 'empty' && (
          <button
            type="button"
            onClick={() => void operation(startIndex, 'Indexing could not be started.')}
          >
            Build index
          </button>
        )}
        {index.status === 'failed' && (
          <>
            <p role="alert">{index.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              Retry indexing
            </button>
          </>
        )}
        {index.corpusMissing && (
          <p>
            No corpus file is present. Run{' '}
            <code>pnpm --filter @galaxie/example-rag-browser corpus</code> to build it, or index
            pasted text below.
          </p>
        )}
        <p>
          Chat preparation may download WebLLM weights (868.5 MB, plus its library and tokenizer).
          Chrome manages the Built-in AI download; its size is not reported.
        </p>
        <button
          type="button"
          disabled={index.status !== 'ready' || busy || !!host}
          onClick={() => void prepare()}
        >
          {preparing ? 'Preparing chat models…' : host ? 'Chat models prepared' : 'Prepare models'}
        </button>
        {pythonBuild.available ? (
          <>
            <p>
              Python adds{' '}
              {Number(
                document.querySelector<HTMLMetaElement>('meta[name="galaxie-python-bytes"]')
                  ?.content ?? pythonBuild.bytes,
              ).toLocaleString('en-US')}{' '}
              bytes of download. Cold start was about 3 s in a local headless Chromium test.
            </p>
            {(!host || index.status !== 'ready') && (
              <p id="executor-reason">Prepare chat models first.</p>
            )}
            <fieldset
              disabled={busy || !host || index.status !== 'ready'}
              aria-describedby={!host || index.status !== 'ready' ? 'executor-reason' : undefined}
            >
              <legend>Agent executor</legend>
              <label>
                <input
                  ref={javascriptOption}
                  type="radio"
                  name="executor"
                  value="javascript"
                  checked={executor === 'javascript'}
                  onChange={() => {
                    setAnswer(undefined);
                    void host?.selectExecutor('javascript');
                  }}
                />
                LangGraph.js
              </label>
              <label>
                <input
                  type="radio"
                  name="executor"
                  value="python"
                  checked={executor === 'python'}
                  onChange={() => {
                    setAnswer(undefined);
                    void host?.selectExecutor('python');
                  }}
                />
                LangGraph Python
              </label>
            </fieldset>
            <p role="status">
              {pythonPhase === 'booting'
                ? 'Preparing LangGraph Python…'
                : pythonPhase === 'ready'
                  ? 'LangGraph Python ready'
                  : ''}
            </p>
            {pythonPhase === 'booting' && (
              <>
                <p>Elapsed: {bootSeconds.toFixed(1)} s</p>
                <button type="button" onClick={() => void host?.cancelPythonBoot()}>
                  Cancel Python boot
                </button>
              </>
            )}
            {pythonPhase === 'failed' && (
              <p role="alert">The Python version could not be prepared.</p>
            )}
          </>
        ) : (
          <p>Python version not included in this build</p>
        )}
      </section>
      <section aria-labelledby="ask-heading">
        <h2 id="ask-heading">Ask a question</h2>
        {reason && <p id="ask-reason">{reason}</p>}
        <label htmlFor="question">Question</label>
        <textarea
          id="question"
          value={question}
          maxLength={4000}
          disabled={!!reason || busy}
          aria-describedby={reason ? 'ask-reason' : undefined}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <label htmlFor="mode">Search mode</label>
        <select
          id="mode"
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value as SearchMode)}
        >
          <option value="fulltext">Full-text</option>
          <option value="vector">Vector</option>
          <option value="hybrid">Hybrid</option>
        </select>
        <button
          type="button"
          disabled={!!reason || busy || !question.trim()}
          onClick={() => void ask()}
        >
          Ask
        </button>
        <p role="status">Run: {runStatus}</p>
        {running && (
          <button
            type="button"
            onClick={() => {
              const runId = active?.getSnapshot().run?.runId;
              if (runId) void active?.cancel(runId);
            }}
          >
            Cancel answer
          </button>
        )}
        {active && (
          <ModelRoutes
            instance={active}
            labels={{
              roles: { 'rag.answer': 'Answer' },
              providers: { mock: 'Mock model', builtin: 'Chrome Built-in AI', webllm: 'WebLLM' },
            }}
          />
        )}
        {error && (
          <>
            <p role="alert">{error}</p>
            <button type="button" disabled={busy || !!reason} onClick={() => void ask()}>
              Retry question
            </button>
          </>
        )}
        {answer && (
          <article>
            <h3 ref={answerHeading} tabIndex={-1}>
              Answer · {answerExecutor === 'python' ? 'LangGraph Python' : 'LangGraph.js'}
            </h3>
            <p className="answer">{answer.answer}</p>
            {answer.citations.length === 0 && <p>No retrieved passage is cited for this answer.</p>}
            {noMatch && (
              <p>No passages matched this question in {mode} search. Try another search mode.</p>
            )}
            <ol aria-label="Cited passages">
              {answer.citations.map((citation) => (
                <li key={citation.marker} value={citation.marker}>
                  <strong>
                    [{citation.marker}] {citation.title}
                  </strong>
                  <p>{citation.text}</p>
                </li>
              ))}
            </ol>
          </article>
        )}
      </section>
      <section aria-labelledby="paste-heading">
        <h2 id="paste-heading">Add your text</h2>
        <p id="paste-note">
          Pasted text is stored on this device until “Clear data” or browser eviction. Only “Clear
          data” removes pasted text; individual removal is unavailable.
        </p>
        <label htmlFor="paste">Text to index</label>
        <textarea
          id="paste"
          value={paste}
          aria-describedby="paste-note"
          disabled={busy}
          onChange={(event) => setPaste(event.target.value)}
        />
        {paste.length > 200000 && (
          <p role="alert">Pasted text must be at most 200,000 characters.</p>
        )}
        <button
          type="button"
          disabled={busy || index.status !== 'ready' || !paste.trim() || paste.length > 200000}
          onClick={() =>
            void operation(async () => {
              await retrieval.paste(paste);
              setPaste('');
            }, 'The pasted text could not be indexed.')
          }
        >
          Index pasted text
        </button>
        {index.added > 0 && <p role="status">Added {index.added} passages.</p>}
      </section>
      <section aria-labelledby="eval-heading">
        <h2 id="eval-heading">Retrieval demonstration</h2>
        <p>
          Recall and MRR describe this corpus and model. They are demonstrations, without pass/fail
          thresholds.
        </p>
        <button
          type="button"
          disabled={busy || index.status !== 'ready' || !corpus?.questions.length}
          onClick={() => void runEvaluation()}
        >
          Evaluate retrieval
        </button>
        {evaluating && (
          <button type="button" onClick={() => controller.current?.abort()}>
            Cancel evaluation
          </button>
        )}
        <p role="status">{evalProgress}</p>
        {rows.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption>Validation sample: N = {rows[0]?.n}</caption>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Recall@1</th>
                  <th>Recall@5</th>
                  <th>Recall@10</th>
                  <th>MRR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.mode}>
                    <th>{row.mode}</th>
                    <td>{row.recall1.toFixed(3)}</td>
                    <td>{row.recall5.toFixed(3)}</td>
                    <td>{row.recall10.toFixed(3)}</td>
                    <td>{row.mrr.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <footer>
        <p>
          {attribution}{' '}
          <a href="https://creativecommons.org/licenses/by-sa/4.0/" rel="noreferrer">
            CC BY-SA 4.0 license
          </a>
          .{' '}
          <a href="https://rajpurkar.github.io/SQuAD-explorer/" rel="noreferrer">
            SQuAD source
          </a>
          . Mock mode uses original synthetic passages.
        </p>
        <p>
          The retrieval cache is separate from galaxie session storage and its retention and logout
          controls. Model answers and retrieved passages render as text.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() => void operation(clear, 'The data could not be cleared.')}
        >
          Clear data (keep downloaded model files)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void operation(
              () => retrieval.removeModel(),
              'The downloaded embedding model could not be removed.',
            )
          }
        >
          Remove downloaded model
        </button>
      </footer>
    </main>
  );
}
