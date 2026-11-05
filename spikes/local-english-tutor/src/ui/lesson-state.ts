// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The page's record of one lesson run, built from the graph's events, and the numbers the page
// reports about it.

import {
  compareWithDictionary,
  type DictionaryEntry,
  type DictionaryMatch,
} from '../agent/dictionary.js';
import { type LessonContent, SECTION_ORDER, type SectionName } from '../agent/lesson.js';
import type { LessonEvent, LessonSections } from '../agent/lesson-graph.js';
import { splitWords } from '../agent/words.js';

export interface Lesson {
  readonly id: number;
  readonly sentence: string;
  readonly words: readonly string[];
  readonly startedAt: number;
  readonly dictionary?: readonly DictionaryEntry[];
  readonly sections: LessonSections;
  /** The raw reply so far of each section the model is writing. */
  readonly progress: { readonly [Name in SectionName]?: string };
  /** When each section's result arrived, in milliseconds after the lesson started. */
  readonly readyAfterMs: { readonly [Name in SectionName]?: number };
  readonly finished: boolean;
  readonly error?: string;
}

export function newLesson(id: number, sentence: string): Lesson {
  return {
    id,
    sentence,
    words: splitWords(sentence),
    startedAt: performance.now(),
    sections: {},
    progress: {},
    readyAfterMs: {},
    finished: false,
  };
}

export function applyEvent(lesson: Lesson, event: LessonEvent): Lesson {
  switch (event.type) {
    case 'dictionary':
      return { ...lesson, dictionary: event.value };
    case 'progress':
      return { ...lesson, progress: { ...lesson.progress, [event.section]: event.text } };
    case 'sections': {
      const now = Math.round(performance.now() - lesson.startedAt);
      const readyAfterMs: { [Name in SectionName]?: number } = { ...lesson.readyAfterMs };
      for (const name of Object.keys(event.value) as SectionName[]) {
        readyAfterMs[name] ??= now;
      }
      return { ...lesson, sections: { ...lesson.sections, ...event.value }, readyAfterMs };
    }
  }
}

/** A section's content, once the model has written it. */
function contentOf<Name extends SectionName>(
  lesson: Lesson,
  name: Name,
): LessonContent[Name] | undefined {
  const result = lesson.sections[name];
  return result?.status === 'done' ? result.value : undefined;
}

/** The model's transcription of each word compared with the dictionary, once both exist. */
export function dictionaryMatches(lesson: Lesson): (DictionaryMatch | undefined)[] {
  const words = contentOf(lesson, 'breakdown')?.words ?? [];
  return lesson.words.map((_, position) => {
    const ipa = words[position]?.ipa;
    const entry = lesson.dictionary?.[position];
    return ipa === undefined || entry === undefined ? undefined : compareWithDictionary(ipa, entry);
  });
}

export interface SectionStats {
  readonly section: SectionName;
  readonly status: 'done' | 'failed';
  readonly readyAfterMs: number | undefined;
  readonly attempts: number;
  /** Null unless the worker reported stats for every attempt. */
  readonly promptTokens: number | null;
  readonly newTokens: number | null;
  /** The last measured attempt's decoding speed. */
  readonly decodeTokensPerSecond: number | null;
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

export function sectionStats(lesson: Lesson): SectionStats[] {
  return SECTION_ORDER.flatMap((section) => {
    const result = lesson.sections[section];
    if (result === undefined) {
      return [];
    }
    const stats = result.attempts.flatMap((attempt) =>
      attempt.stats === undefined ? [] : [attempt.stats],
    );
    const measured = stats.length === result.attempts.length;
    return [
      {
        section,
        status: result.status,
        readyAfterMs: lesson.readyAfterMs[section],
        attempts: result.attempts.length,
        promptTokens: measured ? sum(stats.map((stat) => stat.promptTokens)) : null,
        newTokens: measured ? sum(stats.map((stat) => stat.newTokens)) : null,
        decodeTokensPerSecond: stats.at(-1)?.decodeTokensPerSecond ?? null,
      },
    ];
  });
}

/** What the page logs to the console when a lesson finishes, for the spike's results. */
export function lessonSummary(lesson: Lesson): unknown {
  const matches = dictionaryMatches(lesson);
  const count = (match: DictionaryMatch): number =>
    matches.filter((value) => value === match).length;
  return {
    sentence: lesson.sentence,
    words: lesson.words.length,
    error: lesson.error,
    ipa: {
      kept: count('kept'),
      changed: count('changed'),
      notInDictionary: count('not-in-dictionary'),
    },
    // The model decides the length of these lists, within the schema's bounds.
    items: {
      tips: contentOf(lesson, 'pronunciation')?.tips.length,
      phrases: contentOf(lesson, 'phrases')?.phrases.length,
      situations: contentOf(lesson, 'usage')?.situations.length,
      examples: contentOf(lesson, 'examples')?.examples.length,
      dialogue: contentOf(lesson, 'caseStudy')?.dialogue.length,
    },
    sections: sectionStats(lesson).map((stats) => {
      const attempts = lesson.sections[stats.section]?.attempts ?? [];
      return {
        ...stats,
        errors: attempts.flatMap((attempt) => (attempt.error === undefined ? [] : [attempt.error])),
        forcedTokens: sum(attempts.map((attempt) => attempt.stats?.forcedTokens ?? 0)),
      };
    }),
  };
}
