// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type LangGraphAgent, requestInteraction } from '@galaxie/adapter-langgraph';
import { GalaxieError } from '@galaxie/core';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { type Lesson, QuizDraftSchema, type Review, ReviewSchema } from './schemas.js';

interface QuizQuestion {
  id: string;
  prompt: string;
  options: { id: string; label: string }[];
}

const input = Annotation.Root({ lessonId: Annotation<string> });
const output = Annotation.Root({
  lessonId: Annotation<string>,
  score: Annotation<number>,
  total: Annotation<number>,
  saved: Annotation<boolean>,
});
const state = Annotation.Root({
  ...input.spec,
  ...output.spec,
  lesson: Annotation<Lesson>,
  quiz: Annotation<QuizQuestion[]>,
  answerKey: Annotation<Record<string, string>>,
  answers: Annotation<Record<string, string>>,
  sentence: Annotation<string>,
  review: Annotation<Review>,
});

/** Builds a fresh graph and uses only the host's run-bound services. */
export function createTutorAgent(): LangGraphAgent {
  return (host) => {
    const quizModel = host.langchain
      .chatModel('quiz.generate')
      .withStructuredOutput(QuizDraftSchema);
    const feedbackModel = host.langchain
      .chatModel('tutor.feedback')
      .withStructuredOutput(ReviewSchema);
    const practice = new StateGraph(state, { input, output })
      .addNode('loadLesson', async ({ lessonId }, config) => ({
        lesson: (await host.capabilities.call('lessons.get@1', { lessonId }, config)) as Lesson,
      }))
      .addNode('generateQuiz', async ({ lesson }, config) => {
        const draft = await quizModel.invoke(
          [
            new SystemMessage(
              'Generate 3 to 5 English practice questions with 3 or 4 options each and a correctOptionId naming one option. Return the requested JSON structure.',
            ),
            new HumanMessage(
              JSON.stringify({ content: lesson.content, grammarPoint: lesson.grammarPoint }),
            ),
          ],
          config,
        );
        const answerKey: Record<string, string> = {};
        const quiz = draft.questions.map((question, index) => {
          const correctIndex = question.options.findIndex(
            (option) => option.id === question.correctOptionId,
          );
          if (correctIndex < 0) throw new GalaxieError('invalid', 'The generated quiz is invalid.');
          const id = `q${index + 1}`;
          answerKey[id] = String.fromCharCode(97 + correctIndex);
          return {
            id,
            prompt: question.prompt,
            options: question.options.map((option, optionIndex) => ({
              id: String.fromCharCode(97 + optionIndex),
              label: option.label,
            })),
          };
        });
        return { quiz, answerKey };
      })
      .addNode('askQuiz', ({ quiz, lesson }, config) => {
        const submission = requestInteraction(
          {
            surfaceId: 'lesson-main',
            component: 'education.Quiz/v1',
            viewRevision: 'quiz-v1',
            props: { title: lesson.title, questions: quiz },
          },
          config,
        );
        return { answers: (submission.payload as { answers: Record<string, string> }).answers };
      })
      .addNode('grade', ({ quiz, answers, answerKey }) => ({
        score: quiz.filter(({ id }) => Object.hasOwn(answers, id) && answers[id] === answerKey[id])
          .length,
        total: quiz.length,
      }))
      .addNode('askSentence', ({ lesson }, config) => {
        const submission = requestInteraction(
          {
            surfaceId: 'lesson-main',
            component: 'education.WritingPrompt/v1',
            viewRevision: 'writing-v1',
            props: { prompt: `Write one sentence using ${lesson.grammarPoint}.` },
          },
          config,
        );
        return { sentence: (submission.payload as { sentence: string }).sentence };
      })
      .addNode('reviewSentence', async ({ lesson, sentence }, config) => ({
        review: await feedbackModel.invoke(
          [
            new SystemMessage(
              'Review the learner sentence using the rubric. Return a verdict and 1 to 3 brief English comments in the requested JSON structure.',
            ),
            new HumanMessage(
              JSON.stringify({
                rubric: lesson.rubric,
                grammarPoint: lesson.grammarPoint,
                sentence,
              }),
            ),
          ],
          config,
        ),
      }))
      .addNode('showFeedback', ({ quiz, answerKey, answers, review }, config) => {
        const items = quiz.map((question) => ({
          id: question.id,
          kind:
            Object.hasOwn(answers, question.id) && answers[question.id] === answerKey[question.id]
              ? 'correct'
              : 'incorrect',
          text: `${question.prompt} Correct answer: ${question.options.find((option) => option.id === answerKey[question.id])?.label}.`,
        }));
        requestInteraction(
          {
            surfaceId: 'lesson-main',
            component: 'education.Feedback/v1',
            viewRevision: 'feedback-v1',
            props: {
              items: [
                ...items,
                ...review.comments.map((text, index) => ({
                  id: `review${index + 1}`,
                  kind: 'info',
                  text,
                })),
              ],
            },
          },
          config,
        );
        return {};
      })
      .addNode(
        'saveProgress',
        async ({ lessonId, score, total }, config) =>
          (await host.capabilities.call('progress.save@1', { lessonId, score, total }, config)) as {
            saved: true;
          },
      )
      .addNode('showProgress', ({ lesson, score, total }, config) => {
        requestInteraction(
          {
            surfaceId: 'lesson-main',
            component: 'education.Progress/v1',
            viewRevision: 'progress-v1',
            props: { label: lesson.title, current: score, total },
          },
          config,
        );
        return {};
      })
      .addEdge(START, 'loadLesson')
      .addEdge('loadLesson', 'generateQuiz')
      .addEdge('generateQuiz', 'askQuiz')
      .addEdge('askQuiz', 'grade')
      .addEdge('grade', 'askSentence')
      .addEdge('askSentence', 'reviewSentence')
      .addEdge('reviewSentence', 'showFeedback')
      .addEdge('showFeedback', 'saveProgress')
      .addEdge('saveProgress', 'showProgress')
      .addEdge('showProgress', END)
      .compile();
    // LangGraph streams every state channel despite its output schema. The parent owns only
    // public channels, so the adapter's final root values are the practice graph's projection.
    return new StateGraph(output, { input, output })
      .addNode('practice', async ({ lessonId }, config) => {
        const result = await practice.invoke(
          { lessonId },
          { ...config, outputKeys: Object.keys(state.spec) },
        );
        return {
          lessonId: result.lessonId,
          score: result.score,
          total: result.total,
          saved: result.saved,
        };
      })
      .addEdge(START, 'practice')
      .addEdge('practice', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
  };
}
