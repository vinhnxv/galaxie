// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// The lesson agent as a LangGraph.js graph. Two nodes start together: `lookup`, a deterministic
// tool that asks the pronunciation dictionary about each word, and `overview`, the first model
// section. The other six sections wait for both and use their output as context. Each section node
// asks the model to fill its schema. The worker runs one generation at a time, so the sections
// finish one after another.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import type { ChatWebGpuCallOptions } from './chat-model.js';
import { type DictionaryEntry, lookUp } from './dictionary.js';
import { type Attempt, generateJson, JsonOutputError } from './json-output.js';
import {
  type LessonContent,
  promptFor,
  SECTIONS,
  type SectionContext,
  type SectionName,
  type SectionSpec,
} from './lesson.js';
import { splitWords } from './words.js';

const REPAIRS = 1;
const PROGRESS_INTERVAL_MS = 150;

type Model = BaseChatModel<ChatWebGpuCallOptions>;

export type SectionResult<Name extends SectionName> =
  | {
      readonly status: 'done';
      readonly value: LessonContent[Name];
      readonly attempts: readonly Attempt[];
    }
  | { readonly status: 'failed'; readonly error: string; readonly attempts: readonly Attempt[] };

export type LessonSections = { readonly [Name in SectionName]?: SectionResult<Name> };

const LessonState = Annotation.Root({
  sentence: Annotation<string>(),
  dictionary: Annotation<readonly DictionaryEntry[] | undefined>(),
  sections: Annotation<LessonSections>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});

type State = typeof LessonState.State;

/** What a node returns, and so what the graph's `updates` stream carries for it. */
interface NodeOutput {
  readonly dictionary?: readonly DictionaryEntry[];
  readonly sections?: LessonSections;
}

export type LessonEvent =
  | { readonly type: 'dictionary'; readonly value: readonly DictionaryEntry[] }
  | { readonly type: 'sections'; readonly value: LessonSections }
  | { readonly type: 'progress'; readonly section: SectionName; readonly text: string };

const isAbort = (error: unknown, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');

function contextOf(state: State): SectionContext {
  const overview = state.sections.overview;
  return {
    sentence: state.sentence,
    words: splitWords(state.sentence),
    ...(state.dictionary === undefined ? {} : { dictionary: state.dictionary }),
    ...(overview?.status === 'done' ? { overview: overview.value } : {}),
  };
}

function sectionNode<Name extends SectionName>(
  spec: SectionSpec<Name>,
  model: Model,
): (state: State, config: LangGraphRunnableConfig) => Promise<NodeOutput> {
  return async (state, config) => {
    const context = contextOf(state);
    let reportedAt = 0;
    let result: SectionResult<Name>;
    try {
      const { value, attempts } = await generateJson(
        model,
        await promptFor(spec, context),
        spec.schema(context.words),
        {
          maxNewTokens: spec.maxNewTokens(context.words),
          repairs: REPAIRS,
          config,
          onText: (text) => {
            const now = performance.now();
            if (now - reportedAt >= PROGRESS_INTERVAL_MS) {
              reportedAt = now;
              config.writer?.({ section: spec.name, text });
            }
          },
        },
      );
      result = { status: 'done', value, attempts };
    } catch (error) {
      if (isAbort(error, config.signal)) {
        throw error;
      }
      result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        attempts: error instanceof JsonOutputError ? error.attempts : [],
      };
    }
    return { sections: { [spec.name]: result } as LessonSections };
  };
}

const LATER_SECTIONS = [
  'breakdown',
  'pronunciation',
  'phrases',
  'usage',
  'examples',
  'caseStudy',
] as const satisfies readonly SectionName[];

function buildGraph(model: Model) {
  const graph = new StateGraph(LessonState)
    .addNode(
      'lookup',
      async (state: State): Promise<NodeOutput> => ({
        dictionary: await lookUp(splitWords(state.sentence)),
      }),
    )
    .addNode('overview', sectionNode(SECTIONS.overview, model))
    .addNode('breakdown', sectionNode(SECTIONS.breakdown, model))
    .addNode('pronunciation', sectionNode(SECTIONS.pronunciation, model))
    .addNode('phrases', sectionNode(SECTIONS.phrases, model))
    .addNode('usage', sectionNode(SECTIONS.usage, model))
    .addNode('examples', sectionNode(SECTIONS.examples, model))
    .addNode('caseStudy', sectionNode(SECTIONS.caseStudy, model))
    .addEdge(START, 'lookup')
    .addEdge(START, 'overview');
  for (const name of LATER_SECTIONS) {
    graph.addEdge(['lookup', 'overview'], name).addEdge(name, END);
  }
  return graph.compile();
}

export interface LessonRunner {
  run(sentence: string, signal: AbortSignal, onEvent: (event: LessonEvent) => void): Promise<void>;
}

export function createLessonRunner(model: Model): LessonRunner {
  const graph = buildGraph(model);
  return {
    async run(sentence, signal, onEvent) {
      const stream = await graph.stream(
        { sentence },
        { streamMode: ['updates', 'custom'], signal },
      );
      for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
        if (mode === 'custom') {
          const { section, text } = chunk as { section: SectionName; text: string };
          onEvent({ type: 'progress', section, text });
          continue;
        }
        for (const update of Object.values(chunk as Record<string, NodeOutput>)) {
          if (update.dictionary !== undefined) {
            onEvent({ type: 'dictionary', value: update.dictionary });
          }
          if (update.sections !== undefined) {
            onEvent({ type: 'sections', value: update.sections });
          }
        }
      }
    },
  };
}
