// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// One lesson: the sentence with clickable words, then each section as the model fills it in.

import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { DictionaryEntry, DictionaryMatch } from '../agent/dictionary.js';
import type { LessonContent, SectionName } from '../agent/lesson.js';
import type { SectionResult } from '../agent/lesson-graph.js';
import { cleanToken } from '../agent/words.js';
import { dictionaryMatches, type Lesson, sectionStats } from './lesson-state.js';
import { speak } from './speech.js';
import { vi } from './strings.js';

interface Props {
  readonly lesson: Lesson;
  readonly canSpeak: boolean;
  readonly onLearn: (sentence: string) => void;
}

export function LessonView({ lesson, canSpeak, onLearn }: Props): ReactNode {
  const [selected, setSelected] = useState<number>();
  const top = useRef<HTMLElement>(null);
  useEffect(() => {
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const select = (position: number): void => {
    setSelected(position);
    const word = lesson.words[position];
    if (canSpeak && word !== undefined) {
      speak(word);
    }
  };

  return (
    <article className="lesson" ref={top}>
      <header className="lesson-head">
        <SentenceWords sentence={lesson.sentence} selected={selected} onSelect={select} />
        <SpeakButton text={lesson.sentence} enabled={canSpeak} />
      </header>
      {lesson.error !== undefined && (
        <p className="run-error" role="alert">
          {vi.status.runFailed(lesson.error)}
        </p>
      )}

      <SectionCard name="overview" lesson={lesson}>
        {(value) => (
          <>
            <p className="translation">{value.translation}</p>
            <p>{value.meaning}</p>
            <p className="tag">{vi.tone[value.tone]}</p>
          </>
        )}
      </SectionCard>

      <WordsCard lesson={lesson} selected={selected} onSelect={select} />

      <SectionCard name="pronunciation" lesson={lesson}>
        {(value) => (
          <ul className="tips">
            {value.tips.map((tip) => (
              <li key={`${tip.focus}|${tip.tip}`}>
                <strong lang="en">{tip.focus}</strong> {tip.tip}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard name="phrases" lesson={lesson}>
        {(value) =>
          value.phrases.length === 0 ? (
            <p>{vi.phrasesEmpty}</p>
          ) : (
            <dl className="phrases">
              {value.phrases.map((phrase) => (
                <div key={phrase.phrase}>
                  <dt>
                    <span lang="en">{phrase.phrase}</span>
                    <SpeakButton text={phrase.phrase} enabled={canSpeak} />
                  </dt>
                  <dd>
                    <strong>{phrase.meaning}.</strong> {phrase.note}
                  </dd>
                </div>
              ))}
            </dl>
          )
        }
      </SectionCard>

      <SectionCard name="usage" lesson={lesson}>
        {(value) => (
          <>
            <h3>{vi.usage.when}</h3>
            <p>{value.whenToUse}</p>
            <h3>{vi.usage.situations}</h3>
            <ul>
              {value.situations.map((situation) => (
                <li key={situation}>{situation}</li>
              ))}
            </ul>
            <h3>{vi.usage.avoid}</h3>
            <p>{value.avoid}</p>
          </>
        )}
      </SectionCard>

      <SectionCard name="examples" lesson={lesson}>
        {(value) => (
          <ul className="sentences">
            {value.examples.map((example) => (
              <li key={example.en}>
                <p className="en" lang="en">
                  {example.en}
                </p>
                <p className="vi">{example.vi}</p>
                <SentenceActions sentence={example.en} canSpeak={canSpeak} onLearn={onLearn} />
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard name="caseStudy" lesson={lesson}>
        {(value) => (
          <>
            <h3>{value.title}</h3>
            <p>
              <strong>{vi.caseStudy.setting}:</strong> {value.setting}
            </p>
            <ol className="sentences dialogue">
              {value.dialogue.map((line) => (
                <li key={`${line.speaker}|${line.en}`}>
                  <p className="en">
                    <strong>{line.speaker}:</strong> <span lang="en">{line.en}</span>
                  </p>
                  <p className="vi">{line.vi}</p>
                  <SentenceActions sentence={line.en} canSpeak={canSpeak} onLearn={onLearn} />
                </li>
              ))}
            </ol>
            <p>
              <strong>{vi.caseStudy.takeaway}:</strong> {value.takeaway}
            </p>
          </>
        )}
      </SectionCard>

      <Stats lesson={lesson} />
    </article>
  );
}

interface Token {
  readonly text: string;
  readonly index: number;
  /** The word's position in the lesson's word list; absent for whitespace and bare punctuation. */
  readonly position?: number;
}

function tokenize(sentence: string): Token[] {
  let position = 0;
  return sentence
    .split(/(\s+)/)
    .filter((text) => text !== '')
    .map((text, index) =>
      cleanToken(text) === '' ? { text, index } : { text, index, position: position++ },
    );
}

function SentenceWords(props: {
  readonly sentence: string;
  readonly selected: number | undefined;
  readonly onSelect: (position: number) => void;
}): ReactNode {
  return (
    <p className="sentence" lang="en">
      {tokenize(props.sentence).map((token) => {
        const { position } = token;
        if (position === undefined) {
          return <span key={token.index}>{token.text}</span>;
        }
        return (
          <button
            type="button"
            key={token.index}
            className="word"
            aria-pressed={props.selected === position}
            onClick={() => props.onSelect(position)}
          >
            {token.text}
          </button>
        );
      })}
    </p>
  );
}

function SpeakButton(props: { readonly text: string; readonly enabled: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="speak"
      disabled={!props.enabled}
      aria-label={vi.actions.speakText(props.text)}
      onClick={() => speak(props.text)}
    >
      {vi.actions.speak}
    </button>
  );
}

function SentenceActions(props: {
  readonly sentence: string;
  readonly canSpeak: boolean;
  readonly onLearn: (sentence: string) => void;
}): ReactNode {
  return (
    <p className="actions">
      <SpeakButton text={props.sentence} enabled={props.canSpeak} />
      <button type="button" onClick={() => props.onLearn(props.sentence)}>
        {vi.actions.learnThis}
      </button>
    </p>
  );
}

function SectionCard<Name extends SectionName>(props: {
  readonly name: Name;
  readonly lesson: Lesson;
  readonly children: (value: LessonContent[Name]) => ReactNode;
}): ReactNode {
  const result: SectionResult<Name> | undefined = props.lesson.sections[props.name];
  return (
    <section className="card" aria-busy={result === undefined && !props.lesson.finished}>
      <h2>{vi.sections[props.name]}</h2>
      {result?.status === 'done' ? (
        props.children(result.value)
      ) : (
        <SectionStatus name={props.name} lesson={props.lesson} />
      )}
    </section>
  );
}

function SectionStatus(props: { readonly name: SectionName; readonly lesson: Lesson }): ReactNode {
  const result = props.lesson.sections[props.name];
  if (result?.status === 'failed') {
    const last = result.attempts.at(-1);
    return (
      <div className="failed">
        <p>{vi.status.failed}</p>
        <p className="detail">{result.error}</p>
        {last !== undefined && (
          <details>
            <summary>{vi.status.lastReply}</summary>
            <pre>{last.text}</pre>
          </details>
        )}
      </div>
    );
  }
  if (result !== undefined || props.lesson.finished) {
    return null;
  }
  const text = props.lesson.progress[props.name];
  return (
    <div className="pending">
      <p>{text === undefined ? vi.status.waiting : vi.status.writing(text.length)}</p>
      {text !== undefined && <pre className="raw">{text.slice(-360)}</pre>}
    </div>
  );
}

function WordsCard(props: {
  readonly lesson: Lesson;
  readonly selected: number | undefined;
  readonly onSelect: (position: number) => void;
}): ReactNode {
  const { lesson } = props;
  const breakdown = lesson.sections.breakdown;
  const notes = breakdown?.status === 'done' ? breakdown.value.words : undefined;
  const matches = dictionaryMatches(lesson);
  const rows = lesson.words.map((word, position) => ({
    word,
    position,
    note: notes?.[position],
    entry: lesson.dictionary?.[position],
    match: matches[position],
  }));
  return (
    <section className="card" aria-busy={notes === undefined && !lesson.finished}>
      <h2>{vi.sections.breakdown}</h2>
      <div className="table-scroll">
        <table className="words">
          <thead>
            <tr>
              <th scope="col">{vi.words.word}</th>
              <th scope="col">{vi.words.ipa}</th>
              <th scope="col">{vi.words.meaning}</th>
              <th scope="col">{vi.words.role}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.position} className={row.position === props.selected ? 'selected' : ''}>
                <th scope="row">
                  <button
                    type="button"
                    className="word"
                    lang="en"
                    onClick={() => props.onSelect(row.position)}
                  >
                    {row.word}
                  </button>
                </th>
                <td>
                  {row.note === undefined ? (
                    vi.words.pending
                  ) : (
                    <Ipa ipa={row.note.ipa} entry={row.entry} match={row.match} />
                  )}
                </td>
                <td>{row.note?.meaning ?? vi.words.pending}</td>
                <td>{row.note?.role ?? vi.words.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes === undefined && <SectionStatus name="breakdown" lesson={lesson} />}
      <p className="caveat">{vi.words.caveat}</p>
    </section>
  );
}

function Ipa(props: {
  readonly ipa: string;
  readonly entry: DictionaryEntry | undefined;
  readonly match: DictionaryMatch | undefined;
}): ReactNode {
  const shown = props.ipa.replace(/^[/[]+|[/\]]+$/g, '');
  return (
    <>
      <span className="ipa">/{shown}/</span>
      {props.match === 'kept' && <span className="badge kept">{vi.words.kept}</span>}
      {props.match === 'changed' && props.entry !== undefined && (
        <>
          <span className="badge changed">{vi.words.changed}</span>
          <small className="dictionary-forms">{vi.words.changedTitle(props.entry.ipa)}</small>
        </>
      )}
      {props.match === 'not-in-dictionary' && (
        <span className="badge own">{vi.words.modelOnly}</span>
      )}
    </>
  );
}

function Stats(props: { readonly lesson: Lesson }): ReactNode {
  const rows = sectionStats(props.lesson);
  if (rows.length === 0) {
    return null;
  }
  return (
    <section className="card stats">
      <h2>{vi.stats.title}</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{vi.stats.section}</th>
              <th scope="col">{vi.stats.readyAfter}</th>
              <th scope="col">{vi.stats.tokens}</th>
              <th scope="col">{vi.stats.speed}</th>
              <th scope="col">{vi.stats.attempts}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.section} className={row.status === 'failed' ? 'failed-row' : ''}>
                <th scope="row">{vi.sections[row.section]}</th>
                <td>{row.readyAfterMs === undefined ? '' : vi.stats.seconds(row.readyAfterMs)}</td>
                <td>
                  {row.promptTokens === null || row.newTokens === null
                    ? vi.stats.unknown
                    : `${vi.stats.number(row.promptTokens)} / ${vi.stats.number(row.newTokens)}`}
                </td>
                <td>
                  {row.decodeTokensPerSecond === null
                    ? vi.stats.unknown
                    : vi.stats.number(row.decodeTokensPerSecond)}
                </td>
                <td>{row.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
