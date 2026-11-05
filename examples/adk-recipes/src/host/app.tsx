// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { goBuild } from 'virtual:adk-recipes-go';
import { pythonBuild } from 'virtual:adk-recipes-python';
import type { RunId } from '@galaxie/core';
import { AgentSurface, ConfirmationPrompt, ModelRoutes, useAgentSnapshot } from '@galaxie/react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { loanOutcome } from '../recipes/loan/interaction.js';
import { LEGAL_DISCLAIMER } from './disclaimer.js';
import { loanConfirmations, loanRegistry } from './loan-approval.js';
import {
  clearSavedLoan,
  createRecipeHost,
  loanSessionKey,
  type RecipeHost,
} from './recipe-host.js';
import { type RecipeId, recipes, selectedRecipe } from './registry.js';

function ActiveRecipe({ host, loan }: { host: RecipeHost; loan: boolean }): ReactElement {
  const snapshot = useAgentSnapshot(host.instance);
  let outcome: ReturnType<typeof loanOutcome> | undefined;
  let invalid = false;
  if (loan) {
    try {
      outcome = loanOutcome(
        'application-lantern',
        snapshot.run?.pending?.props,
        host.capabilities.decisions(),
      );
    } catch {
      // Pending props come from the model's tool arguments: show a fixed alert and keep Start over reachable.
      invalid = true;
    }
  }
  return (
    <>
      <p id="run-status" role="status">
        {snapshot.run?.status ?? snapshot.state}
      </p>
      <ModelRoutes instance={host.instance} />
      {outcome && (
        <>
          <p id="loan-outcome" role="status">
            {outcome.status === 'pending'
              ? `Pending decision: ${outcome.summary.decision}`
              : outcome.status === 'finalized'
                ? `Finalized decision: ${outcome.receipt.decision}`
                : 'Undecided'}
          </p>
          <AgentSurface instance={host.instance} registry={loanRegistry} surfaceId="main" />
          <ConfirmationPrompt instance={host.instance} confirmations={loanConfirmations} />
        </>
      )}
      {invalid && <p role="alert">The loan confirmation is invalid. Use Start over to clear it.</p>}
      {snapshot.run?.error && (
        <p role="alert">
          {Object.keys(snapshot.routes ?? {}).length === 0 &&
          (snapshot.run.error.code === 'unavailable' || snapshot.run.error.code === 'denied')
            ? 'No model is available: WebGPU or device storage may be unavailable, or the download was declined. Use Start over to try again, or run dev:mock.'
            : snapshot.run.error.message}
        </p>
      )}
    </>
  );
}

export function App(): ReactElement {
  const [recipe] = useState(selectedRecipe);
  const [question, setQuestion] = useState(recipe.prompt);
  const [host, setHost] = useState<RecipeHost>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [status, setStatus] = useState('idle');
  const creation = useRef<Promise<RecipeHost> | undefined>(undefined);
  const controller = useRef(new AbortController());
  const switching = useRef(false);
  const mock = import.meta.env.MODE === 'mock';
  const loan = recipe.id === 'loan';

  const open = useCallback(async (): Promise<RecipeHost> => {
    creation.current ??= createRecipeHost(recipe.id, controller.current.signal);
    const active = await creation.current;
    controller.current.signal.throwIfAborted();
    setHost(active);
    await active.prepare();
    return active;
  }, [recipe.id]);
  const follow = useCallback(
    async (active: RecipeHost, runId: RunId): Promise<void> => {
      let author = '';
      for await (const event of active.instance.events(runId)) {
        if (controller.current.signal.aborted) break;
        if (event.type === 'stream' && event.mode === 'messages') {
          const data = event.data as { author?: unknown; text?: unknown };
          // These adapters release only checked model messages, never raw framework updates.
          // Decision prose cannot establish a loan outcome, so omit that stage from display.
          if (typeof data?.text !== 'string' || (loan && data.author === 'LoanDecisionAgent'))
            continue;
          const nextAuthor = typeof data.author === 'string' ? data.author : '';
          const separator = author && author !== nextAuthor ? '\n\n' : '';
          author = nextAuthor;
          setText((previous) => previous + separator + data.text);
        } else if (event.type === 'output' && !loan && typeof event.output === 'string') {
          setText(event.output);
        }
      }
    },
    [loan],
  );

  useEffect(() => {
    if (loan && recipe.available && sessionStorage.getItem(loanSessionKey)) {
      setBusy(true);
      setStatus('preparing');
      setStarted(true);
      void (async () => {
        const active = await open();
        const restored = await active.instance.restore();
        if (restored)
          void follow(active, restored.runId).catch(() =>
            setError('The restored run could not be displayed.'),
          );
        else {
          setError('No pending loan could be restored. Start over to clear this session.');
        }
      })()
        .catch(() => {
          if (!controller.current.signal.aborted)
            setError('The loan could not be restored. Start over to try again.');
        })
        .finally(() => setBusy(false));
    }
    const stop = (): void => {
      controller.current.abort();
      void creation.current?.then((active) => active.dispose()).catch(() => {});
    };
    const show = (event: PageTransitionEvent): void => {
      if (event.persisted) location.reload();
    };
    addEventListener('pagehide', stop);
    addEventListener('pageshow', show);
    return () => {
      stop();
      removeEventListener('pagehide', stop);
      removeEventListener('pageshow', show);
    };
  }, [loan, recipe.available, open, follow]);

  const run = async (): Promise<void> => {
    setError('');
    setText('');
    if (question.trim() !== recipe.prompt) {
      setText('Unverifiable: no scripted fixture covers this question. Use the sample question.');
      return;
    }
    setBusy(true);
    setStarted(true);
    setStatus('preparing');
    try {
      const active = await open();
      const run = await active.instance.start({ prompt: question.trim() });
      void follow(active, run.runId).catch(() => {
        if (!controller.current.signal.aborted) setError('The run could not be displayed.');
      });
    } catch {
      if (!controller.current.signal.aborted)
        setError('The recipe could not be prepared or started. Start over to try again.');
    } finally {
      setBusy(false);
    }
  };
  const navigate = async (id: RecipeId, clear = false): Promise<void> => {
    if (switching.current) return;
    switching.current = true;
    setBusy(true);
    try {
      // Clearing must retain the storage fence until the final deletion commits.
      const pending = creation.current;
      if (!clear) controller.current.abort();
      const active = await pending?.catch(() => undefined);
      if (clear && active) await active.clear();
      controller.current.abort();
      await active?.dispose();
      if (clear && loan && !active) await clearSavedLoan();
      const url = new URL(location.href);
      url.searchParams.set('recipe', id);
      location.assign(url.href);
    } catch {
      switching.current = false;
      setBusy(false);
      setError('The recipe could not be closed. Reload before running another recipe.');
    }
  };
  return (
    <main>
      <h1>ADK recipes in the browser</h1>
      <p>Invented companies, applicants and market bulletins. No real-model result is claimed.</p>
      <p>galaxie is not affiliated with or endorsed by Google.</p>
      <p>Do not use these fixtures or outputs for real financial or lending decisions.</p>
      <p id="providers">
        {mock
          ? 'Model available: deterministic mock (in browser). No download is needed.'
          : 'Local ONNX: Qwen3.5-0.8B (WebGPU required). First use asks permission to download 666 MB from Hugging Face. If unavailable or declined, use dev:mock.'}
      </p>
      <p id="assets">
        Python recipe assets: {pythonBuild.available ? 'available' : 'unavailable'}. Go recipe
        assets: {goBuild.available ? 'available' : 'unavailable'}.
      </p>
      {(!pythonBuild.available || !goBuild.available) && (
        <p>
          Disabled recipes need verified local Python wheels or a built Go module. The JavaScript
          recipe needs neither.
        </p>
      )}
      <label htmlFor="recipe">Recipe</label>
      <select
        id="recipe"
        value={recipe.id}
        onChange={(event) => {
          void navigate(event.target.value as RecipeId);
        }}
      >
        {recipes.map((entry) => (
          <option key={entry.id} value={entry.id} disabled={!entry.available}>
            {entry.label}
            {entry.available ? '' : ' — unavailable'}
          </option>
        ))}
      </select>
      {!recipe.available && (
        <p role="alert">This recipe is unavailable. Choose an enabled recipe.</p>
      )}
      {!loan && (
        <>
          <label htmlFor="question">Question</label>
          <textarea
            id="question"
            value={question}
            maxLength={4096}
            disabled={started}
            onChange={(event) => setQuestion(event.target.value)}
          />
        </>
      )}
      <p>
        Sample questions use synthetic fixtures. Questions outside those fixtures are unverifiable.
      </p>
      <button
        type="button"
        disabled={!recipe.available || busy || started}
        onClick={() => {
          void run();
        }}
      >
        Run
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void navigate(recipe.id, true);
        }}
      >
        Start over
      </button>
      {recipe.financial && <p id="disclaimer">{LEGAL_DISCLAIMER}</p>}
      {host ? (
        <ActiveRecipe host={host} loan={loan} />
      ) : (
        <>
          <p id="run-status" role="status">
            {status}
          </p>
          {loan && <p id="loan-outcome">Undecided</p>}
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <h2>Checked output</h2>
      <pre id="output">{text}</pre>
    </main>
  );
}
