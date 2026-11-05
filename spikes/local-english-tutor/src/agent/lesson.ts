// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The lesson's content design: one schema and one instruction per section. The model generates all
// of a section's data from its prompt. The pipeline supplies the context: the sentence, its words
// with what the pronunciation dictionary lists for them, and the overview for every later section.

import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { type DictionaryEntry, lookUp } from './dictionary.js';
import { splitWords } from './words.js';
import { WORKED_EXAMPLE } from './worked-example.js';

const text = z.string().trim().min(1);

export const overviewSchema = z.object({
  tone: z.enum(['formal', 'neutral', 'informal']),
  translation: text,
  meaning: text,
});

const wordSchema = z.object({ word: text, ipa: text, meaning: text, role: text });

export const breakdownSchema = z.object({ words: z.array(wordSchema) });

// The list bounds from here on match the counts that the section instructions ask for. Guided
// generation holds the model to them; free to choose, it tends to stop a list at the minimum.
export const pronunciationSchema = z.object({
  tips: z
    .array(z.object({ focus: text, tip: text }))
    .min(2)
    .max(4),
});

export const phrasesSchema = z.object({
  phrases: z.array(z.object({ phrase: text, meaning: text, note: text })).max(3),
});

export const usageSchema = z.object({
  whenToUse: text,
  situations: z.array(text).min(2).max(4),
  avoid: text,
});

export const examplesSchema = z.object({
  examples: z.array(z.object({ en: text, vi: text })).length(3),
});

export const caseStudySchema = z.object({
  title: text,
  setting: text,
  dialogue: z
    .array(z.object({ speaker: text, en: text, vi: text }))
    .min(3)
    .max(4),
  takeaway: text,
});

export type Overview = z.infer<typeof overviewSchema>;

export interface LessonContent {
  readonly overview: Overview;
  readonly breakdown: z.infer<typeof breakdownSchema>;
  readonly pronunciation: z.infer<typeof pronunciationSchema>;
  readonly phrases: z.infer<typeof phrasesSchema>;
  readonly usage: z.infer<typeof usageSchema>;
  readonly examples: z.infer<typeof examplesSchema>;
  readonly caseStudy: z.infer<typeof caseStudySchema>;
}

export type SectionName = keyof LessonContent;

/** The order the page shows the sections in. */
export const SECTION_ORDER: readonly SectionName[] = [
  'overview',
  'breakdown',
  'pronunciation',
  'phrases',
  'usage',
  'examples',
  'caseStudy',
];

/**
 * One item per listed word, in order, with the word as listed. The words are constants in the
 * schema, so guided generation writes them and the model writes the rest of each item.
 */
function breakdownSchemaFor(words: readonly string[]): z.ZodType<LessonContent['breakdown']> {
  const items = words.map((word) => wordSchema.extend({ word: z.literal(word) }));
  return z.object({ words: z.tuple(items as [(typeof items)[number], ...typeof items]) });
}

export interface SectionSpec<Name extends SectionName> {
  readonly name: Name;
  readonly instruction: string;
  readonly maxNewTokens: (words: readonly string[]) => number;
  readonly schema: (words: readonly string[]) => z.ZodType<LessonContent[Name]>;
  /** Whether the request lists the sentence's words. */
  readonly listsWords: boolean;
}

const fixed =
  <T>(schema: z.ZodType<T>) =>
  (): z.ZodType<T> =>
    schema;

export const SECTIONS: { readonly [Name in SectionName]: SectionSpec<Name> } = {
  overview: {
    name: 'overview',
    instruction:
      'Classify the tone of the sentence, translate it into natural Vietnamese, and explain its ' +
      'meaning and nuance in two or three Vietnamese sentences. ' +
      'Keys: tone ("formal", "neutral" or "informal"), translation (string), meaning (string).',
    maxNewTokens: () => 320,
    schema: fixed(overviewSchema),
    listsWords: false,
  },
  breakdown: {
    name: 'breakdown',
    instruction:
      'For each listed word, in the same order, give its US English IPA, its meaning in this ' +
      'sentence, and its grammatical role (part of speech and function). Write the meaning and the ' +
      'role in Vietnamese. For the IPA, review the dictionary transcriptions listed with the word: ' +
      'keep the one that fits the word as it is used in this sentence, correct it if it is wrong, ' +
      'and write your own for a word the dictionary lacks. Write the IPA without slashes, with ˈ ' +
      'before the stressed syllable of a word of two or more syllables. ' +
      'Keys: words (array of {word, ipa, meaning, role}), with exactly one item per listed word ' +
      'and each word copied exactly as listed.',
    maxNewTokens: (words) => 80 + 64 * words.length,
    schema: breakdownSchemaFor,
    listsWords: true,
  },
  pronunciation: {
    name: 'pronunciation',
    instruction:
      'Give two to four tips in Vietnamese for a Vietnamese speaker saying this sentence aloud: ' +
      'word stress, final consonants, linking between words, weak forms, or sounds that Vietnamese ' +
      'does not have. The focus of each tip is a word or a short group of words from the sentence, ' +
      'followed by its IPA between slashes; base the IPA on the listed dictionary transcriptions. ' +
      'Keys: tips (array of {focus, tip}).',
    maxNewTokens: () => 420,
    schema: fixed(pronunciationSchema),
    listsWords: true,
  },
  phrases: {
    name: 'phrases',
    instruction:
      'Pick up to three useful phrases, collocations or idioms from the sentence. For each, give ' +
      'its Vietnamese meaning and a short Vietnamese note on how it is used. ' +
      'Keys: phrases (array of {phrase, meaning, note}); use an empty array if there are none.',
    maxNewTokens: () => 360,
    schema: fixed(phrasesSchema),
    listsWords: false,
  },
  usage: {
    name: 'usage',
    instruction:
      'Explain in Vietnamese when people say this sentence, list two to four typical situations ' +
      'in Vietnamese, and say in Vietnamese when not to use it. ' +
      'Keys: whenToUse (string), situations (array of strings), avoid (string).',
    maxNewTokens: () => 400,
    schema: fixed(usageSchema),
    listsWords: false,
  },
  examples: {
    name: 'examples',
    instruction:
      'Write three new English sentences that reuse the pattern or the key phrase of the sentence ' +
      'in other situations at a software company, each with a Vietnamese translation. ' +
      'Keys: examples (array of {en, vi}).',
    maxNewTokens: () => 420,
    schema: fixed(examplesSchema),
    listsWords: false,
  },
  caseStudy: {
    name: 'caseStudy',
    instruction:
      'Write a short case study: a realistic scene at work where someone says this sentence. ' +
      'Give a Vietnamese title, the setting in Vietnamese, a dialogue of three or four lines in ' +
      'English with a Vietnamese translation of each line, where one line contains the sentence, ' +
      'and a Vietnamese takeaway. ' +
      'Keys: title, setting, dialogue (array of {speaker, en, vi}), takeaway.',
    maxNewTokens: () => 700,
    schema: fixed(caseStudySchema),
    listsWords: false,
  },
};

const SYSTEM =
  'You are an English teacher for Vietnamese software developers. You explain one English ' +
  'sentence at a time.\n' +
  'Reply with one JSON object and nothing else: no Markdown, no code fences, no comments.\n' +
  'Write every explanation in Vietnamese. Keep English words, phrases and example sentences in ' +
  'English.';

/** What the pipeline tells a section's prompt about the sentence. */
export interface SectionContext {
  readonly sentence: string;
  readonly words: readonly string[];
  /** What the pronunciation dictionary lists for each word, in the same order. */
  readonly dictionary?: readonly DictionaryEntry[];
  /** The overview section's output, once it exists. */
  readonly overview?: Overview;
}

function wordLines(context: SectionContext): string[] {
  if (context.dictionary === undefined) {
    return [`Words, in order: ${context.words.map((word, i) => `${i + 1}. ${word}`).join(' ')}`];
  }
  const { dictionary } = context;
  return [
    'Words, in order, with the IPA the CMU Pronouncing Dictionary lists for each:',
    ...context.words.map((word, i) => {
      const ipa = dictionary[i]?.ipa ?? [];
      return `${i + 1}. ${word}: ${ipa.length > 0 ? ipa.join(' | ') : 'not in the dictionary'}`;
    }),
  ];
}

function request(listsWords: boolean, context: SectionContext): string {
  const lines = [`Sentence: "${context.sentence}"`];
  if (context.overview !== undefined) {
    lines.push(`Vietnamese translation: "${context.overview.translation}"`);
    lines.push(`Meaning: ${context.overview.meaning}`);
  }
  if (listsWords) {
    lines.push(...wordLines(context));
  }
  return lines.join('\n');
}

const EXAMPLE_WORDS = splitWords(WORKED_EXAMPLE.sentence);
let exampleDictionary: Promise<DictionaryEntry[]> | undefined;

/**
 * A section's prompt: the instruction, the worked example as one request and its answer, then the
 * learner's sentence. The example request carries the same kinds of context as the learner's.
 */
export async function promptFor(
  spec: Pick<SectionSpec<SectionName>, 'name' | 'instruction' | 'listsWords'>,
  context: SectionContext,
): Promise<BaseMessage[]> {
  exampleDictionary ??= lookUp(EXAMPLE_WORDS);
  const example: SectionContext = {
    sentence: WORKED_EXAMPLE.sentence,
    words: EXAMPLE_WORDS,
    ...(context.dictionary === undefined ? {} : { dictionary: await exampleDictionary }),
    ...(context.overview === undefined ? {} : { overview: WORKED_EXAMPLE.lesson.overview }),
  };
  return [
    new SystemMessage(`${SYSTEM}\n\nTask: ${spec.instruction}`),
    new HumanMessage(request(spec.listsWords, example)),
    new AIMessage(JSON.stringify(WORKED_EXAMPLE.lesson[spec.name])),
    new HumanMessage(request(spec.listsWords, context)),
  ];
}
