// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { pythonBuild } from 'virtual:rag-python';
import type { RunId } from '@galaxie/core';
import { AgentSurface, ModelRoutes } from '@galaxie/react';
import { type ReactElement, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type RagOutput, RagOutputSchema, type SearchMode } from '../agent/schemas.js';
import { attribution, type Corpus } from '../corpus.js';
import type { RetrievalClient } from '../retrieval/client.js';
import { type EvaluationRow, evaluate } from './evaluate.js';
import { reviewRegistry } from './review-passages.js';
import type { RagExecutor, RagHost } from './runtime.js';
import { answerDelta, startsModelTurn } from './stream.js';

export interface AppProps {
  retrieval: RetrievalClient;
  corpus: Corpus | null;
  startIndex(): Promise<unknown>;
  prepareModels(): Promise<RagHost>;
  disposeModels(): void;
}
const executorNames: Readonly<Record<RagExecutor, string>> = {
  javascript: 'LangGraph.js',
  python: 'LangGraph Python',
  'pydantic-ai': 'pydantic-ai Python',
  dspy: 'DSPy Python',
};
function pythonBytes(framework: 'langgraph' | 'pydantic-ai' | 'dspy'): string {
  const meta = framework === 'langgraph' ? 'galaxie-python-bytes' : `galaxie-${framework}-bytes`;
  return Number(
    document.querySelector<HTMLMetaElement>(`meta[name="${meta}"]`)?.content ??
      pythonBuild.bytes[framework],
  ).toLocaleString('en-US');
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
  const [executor, setExecutor] = useState<RagExecutor>('javascript');
  const [answerExecutor, setAnswerExecutor] = useState<RagExecutor>('javascript');
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
  const [runId, setRunId] = useState<RunId>();
  const [review, setReview] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<RagHost['reviewStatus']>('idle');
  const [reviewRestoreFailed, setReviewRestoreFailed] = useState(false);
  const [streamedAnswer, setStreamedAnswer] = useState('');
  const [retrievalStreamed, setRetrievalStreamed] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [evalProgress, setEvalProgress] = useState('');
  const [rows, setRows] = useState<EvaluationRow[]>([]);
  const controller = useRef<AbortController | undefined>(undefined);
  const answerHeading = useRef<HTMLHeadingElement>(null);
  const requestedRun = useRef<RunId | undefined>(undefined);
  const busy =
    running ||
    reviewing ||
    reviewStatus === 'lost' ||
    reviewStatus === 'busy' ||
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
      setReviewing(host?.reviewing ?? false);
      setReviewStatus(host?.reviewStatus ?? 'idle');
      setReviewRestoreFailed(host?.reviewRestoreFailed ?? false);
      if (host?.reviewing) {
        setReview(true);
        setAnswerExecutor(host.executor);
      }
    };
    update();
    return host?.subscribeExecutor(update);
  }, [host]);
  useEffect(() => {
    const update = (): void => {
      const run = active?.getSnapshot().run;
      setRunStatus(run?.status ?? 'idle');
      setRunId(run?.runId);
      setRunning(run?.status === 'running' || run?.status === 'queued');
    };
    update();
    return active?.subscribe(update);
  }, [active]);
  useEffect(() => {
    if (!active || !runId) return;
    const run = active.getSnapshot().run;
    if (run?.runId !== runId) return;
    if (
      !['queued', 'running', 'waiting_input'].includes(run.status) &&
      runId !== requestedRun.current
    )
      return;
    const iterator = active.events(runId)[Symbol.asyncIterator]();
    let stopped = false;
    void (async () => {
      try {
        while (!stopped) {
          const next = await iterator.next();
          if (stopped || next.done) break;
          const event = next.value;
          if (event.type === 'output') setAnswer(RagOutputSchema.parse(event.output));
          else if (event.type === 'error' && host?.pythonPhase !== 'failed')
            setError(event.error.message);
          else if (event.type === 'stream') {
            if (startsModelTurn(event)) setStreamedAnswer('');
            const delta = answerDelta(event);
            if (delta) setStreamedAnswer((text) => text + delta);
            if (event.path.some((path) => path.startsWith('retrieval:')))
              setRetrievalStreamed(true);
          }
        }
      } catch {
        if (!stopped && host?.pythonPhase !== 'failed')
          setError('The question could not be answered.');
      }
    })();
    return () => {
      stopped = true;
      void iterator.return?.();
    };
  }, [active, runId, host]);
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
    setStreamedAnswer('');
    setRetrievalStreamed(false);
    try {
      requestedRun.current = (
        await host.start({ question, mode, ...(review ? { review: true } : {}) })
      ).runId;
    } catch {
      if (host.pythonPhase !== 'failed') setError('The question could not be answered.');
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
    if (host?.reviewing) await host.startOver();
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
        {executor === 'javascript' ? 'JavaScript' : 'Python'} · {executorNames[executor]}
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
              LangGraph Python adds {pythonBytes('langgraph')} bytes of download. Cold start depends
              on this device.
            </p>
            {host?.pydanticAiAvailable && (
              <p>
                pydantic-ai Python adds {pythonBytes('pydantic-ai')} bytes of download. Cold start
                depends on this device.
              </p>
            )}
            {host?.dspyAvailable && (
              <p>
                DSPy Python adds {pythonBytes('dspy')} bytes of download. Cold start depends on this
                device.
              </p>
            )}
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
                    requestedRun.current = undefined;
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
                    requestedRun.current = undefined;
                    setAnswer(undefined);
                    void host?.selectExecutor('python');
                  }}
                />
                LangGraph Python
              </label>
              {host?.pydanticAiAvailable && (
                <label>
                  <input
                    type="radio"
                    name="executor"
                    value="pydantic-ai"
                    checked={executor === 'pydantic-ai'}
                    onChange={() => {
                      requestedRun.current = undefined;
                      setAnswer(undefined);
                      void host.selectExecutor('pydantic-ai');
                    }}
                  />
                  pydantic-ai Python
                </label>
              )}
              {host?.dspyAvailable && (
                <label>
                  <input
                    type="radio"
                    name="executor"
                    value="dspy"
                    checked={executor === 'dspy'}
                    onChange={() => {
                      requestedRun.current = undefined;
                      setAnswer(undefined);
                      void host.selectExecutor('dspy');
                    }}
                  />
                  DSPy Python
                </label>
              )}
            </fieldset>
            <p role="status">
              {pythonPhase === 'booting'
                ? `Preparing ${executorNames[executor]}…`
                : pythonPhase === 'ready'
                  ? `${executorNames[executor]} ready`
                  : ''}
            </p>
            {pythonPhase === 'booting' && (
              <>
                <p>Elapsed: {bootSeconds.toFixed(1)} s</p>
                {!reviewing && (
                  <button type="button" onClick={() => void host?.cancelPythonBoot()}>
                    Cancel Python boot
                  </button>
                )}
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
        <label>
          <input
            type="checkbox"
            checked={review}
            disabled={busy}
            onChange={(event) => setReview(event.target.checked)}
          />
          Review passages before answering
        </label>
        <p>
          Review sessions stay on this device until Start over, retention cleanup or browser
          eviction. Review selections reset on reload.
        </p>
        {reviewStatus === 'busy' && (
          <p role="status">
            The review is open in another tab.{' '}
            <button
              type="button"
              disabled={preparing}
              onClick={() =>
                void operation(async () => {
                  setPreparing(true);
                  try {
                    await host?.restoreReview(true);
                  } finally {
                    setPreparing(false);
                  }
                }, 'The review could not be restored.')
              }
            >
              Use here
            </button>
          </p>
        )}
        {reviewStatus === 'lost' && (
          <p role="alert">The review moved to another tab. Reload to continue.</p>
        )}
        {reviewRestoreFailed && (
          <p role="alert">The saved review could not be restored. Start over to delete it.</p>
        )}
        {reviewing && active && (
          <>
            <AgentSurface instance={active} registry={reviewRegistry} surfaceId="rag-review" />
            <button
              type="button"
              disabled={running || reviewStatus !== 'owner'}
              onClick={() =>
                void operation(async () => {
                  await host?.startOver();
                  setAnswer(undefined);
                  setStreamedAnswer('');
                  setReview(false);
                }, 'The review could not be deleted.')
              }
            >
              Start over
            </button>
          </>
        )}
        {retrievalStreamed && <p>Retrieval subgraph streamed.</p>}
        {!answer && streamedAnswer && (
          <p role="status" aria-label="Streaming answer">
            {streamedAnswer}
          </p>
        )}
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
              Answer · {executorNames[answerExecutor]}
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
            {answer.citations.length === 0 && answer.sources.length > 0 && (
              <>
                <p id="sources-note">
                  The model placed no passage marker. These passages were sent to it; the answer may
                  draw on any of them.
                </p>
                <ul aria-label="Passages sent to the model" aria-describedby="sources-note">
                  {answer.sources.map((source) => (
                    <li key={source.passageId}>
                      <strong>{source.title}</strong>
                      <p>{source.text}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
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
