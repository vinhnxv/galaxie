// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export {
  educationComponents,
  Feedback,
  type FeedbackItem,
  type FeedbackProps,
  Progress,
  type ProgressProps,
  Quiz,
  type QuizActions,
  type QuizOption,
  type QuizProps,
  type QuizQuestion,
  type QuizSubmission,
} from './components/index.js';
export { useAgentSnapshot } from './hooks.js';
export {
  type ActionDefinition,
  type ActionDefinitions,
  type BoundActions,
  type ComponentEntry,
  type ComponentProps,
  createRegistry,
  defineComponent,
  type InteractionStatus,
  type Registry,
  type RegistryComponent,
  type ResolvedInteraction,
  type SchemaOutput,
} from './registry.js';
export { AgentSurface, type AgentSurfaceProps } from './surface.js';
