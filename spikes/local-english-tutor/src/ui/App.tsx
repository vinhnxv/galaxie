// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The page: the model's load state (with the user's consent before the first download), the
// sentence input, and the current lesson. Starting a lesson cancels the one in progress.

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { ChatWebGpu } from '../agent/chat-model.js';
import { createLessonRunner } from '../agent/lesson-graph.js';
import { EngineClient, type EngineStatus } from '../engine/client.js';
import { FILES, TOTAL_DOWNLOAD_BYTES, weightsAreCached } from '../engine/model-files.js';
import { LessonView } from './LessonView.js';
import { applyEvent, type Lesson, lessonSummary, newLesson } from './lesson-state.js';
import { SAMPLE_SENTENCES } from './sample-sentences.js';
import { useLocalEnglishVoice } from './speech.js';
import { vi } from './strings.js';

const engine = new EngineClient();
const runner = createLessonRunner(new ChatWebGpu(engine));
const MAX_SENTENCE_LENGTH = 200;

let lastLessonId = 0;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function App(): ReactNode {
  const status = useSyncExternalStore(engine.subscribe, () => engine.status);
  const canSpeak = useLocalEnglishVoice();
  const [draft, setDraft] = useState('');
  const [lesson, setLesson] = useState<Lesson>();
  const running = useRef<AbortController>(undefined);
  const logged = useRef(0);
  const ready = status.state === 'ready';

  useEffect(() => {
    if (lesson?.finished === true && logged.current !== lesson.id) {
      logged.current = lesson.id;
      console.info('[tutor] lesson', JSON.stringify(lessonSummary(lesson)));
    }
  }, [lesson]);

  const start = (input: string): void => {
    const sentence = input.trim().slice(0, MAX_SENTENCE_LENGTH);
    if (sentence === '' || !ready) {
      return;
    }
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    const id = ++lastLessonId;
    setDraft(sentence);
    setLesson(newLesson(id, sentence));
    const update = (change: (current: Lesson) => Lesson): void =>
      setLesson((current) => (current?.id === id ? change(current) : current));
    runner
      .run(sentence, controller.signal, (event) => update((current) => applyEvent(current, event)))
      .then(
        () => update((current) => ({ ...current, finished: true })),
        (error: unknown) => {
          if (!controller.signal.aborted) {
            update((current) => ({ ...current, finished: true, error: messageOf(error) }));
          }
        },
      );
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    start(draft);
  };

  return (
    <main>
      <header className="page-head">
        <h1>{vi.title}</h1>
        <p>{vi.subtitle}</p>
      </header>

      <EnginePanel status={status} />

      <form className="card ask" onSubmit={submit}>
        <label htmlFor="sentence">{vi.input.label}</label>
        <div className="ask-row">
          <input
            id="sentence"
            type="text"
            lang="en"
            autoComplete="off"
            maxLength={MAX_SENTENCE_LENGTH}
            placeholder={vi.input.placeholder}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button type="submit" disabled={!ready || draft.trim() === ''}>
            {vi.input.submit}
          </button>
        </div>
        {!ready && <p className="hint">{vi.input.needsModel}</p>}
        <p className="hint">{vi.input.samples}</p>
        <ul className="samples">
          {SAMPLE_SENTENCES.map((sentence) => (
            <li key={sentence}>
              <button type="button" lang="en" disabled={!ready} onClick={() => start(sentence)}>
                {sentence}
              </button>
            </li>
          ))}
        </ul>
        {!canSpeak && <p className="hint">{vi.actions.noVoice}</p>}
      </form>

      {lesson !== undefined && (
        <LessonView key={lesson.id} lesson={lesson} canSpeak={canSpeak} onLearn={start} />
      )}
    </main>
  );
}

function EnginePanel(props: { readonly status: EngineStatus }): ReactNode {
  const { status } = props;
  const [cached, setCached] = useState<boolean>();
  useEffect(() => {
    weightsAreCached().then(setCached, () => setCached(false));
  }, []);
  useEffect(() => {
    // Weights already on this device load without asking; the consent is about the download.
    if (cached === true && status.state === 'idle') {
      engine.load();
    }
  }, [cached, status.state]);

  switch (status.state) {
    case 'idle':
      if (cached !== false) {
        return <p className="card engine">{vi.engine.checkingCache}</p>;
      }
      return (
        <div className="card engine">
          <p>{vi.engine.consent(TOTAL_DOWNLOAD_BYTES)}</p>
          <button
            type="button"
            onClick={() => {
              // Asks the browser not to evict the 1.4 GB of weights under storage pressure.
              navigator.storage.persist().catch(() => false);
              engine.load();
            }}
          >
            {vi.engine.download}
          </button>
        </div>
      );
    case 'loading': {
      const { progress } = status;
      if (progress?.stage === 'loading-files' && progress.file !== undefined) {
        const file = FILES[progress.file as keyof typeof FILES].path;
        const loaded = progress.loadedBytes ?? 0;
        const total = progress.totalBytes ?? 0;
        return (
          <div className="card engine">
            <p>{vi.engine.loadingFile(file, loaded, total)}</p>
            <progress value={loaded} max={total} />
          </div>
        );
      }
      return (
        <p className="card engine">
          {progress?.stage === 'creating-session'
            ? vi.engine.creatingSession
            : vi.engine.checkingGpu}
        </p>
      );
    }
    case 'ready':
      return (
        <p className="card engine ready">
          {vi.engine.ready(status.info.gpu, status.info.filesReadyMs + status.info.sessionCreateMs)}
        </p>
      );
    case 'failed':
      return (
        <div className="card engine failed" role="alert">
          <p>{vi.engine.failed(status.message)}</p>
          <button type="button" onClick={() => engine.load()}>
            {vi.engine.retry}
          </button>
        </div>
      );
  }
}
