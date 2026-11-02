// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { failure } from './errors.js';
import type { HostRegistry } from './host.js';

const MAX_DEPTH = 16;
const MAX_AGENTS = 256;

/** Exact classes only: a subclass can override how the agent runs, so it is not on the list. */
const ALLOWED: ReadonlySet<object> = new Set([
  LlmAgent.prototype,
  SequentialAgent.prototype,
  ParallelAgent.prototype,
  LoopAgent.prototype,
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Fails closed unless every agent, model and tool in the tree is one the adapter can govern
 * (KTD5). A string or foreign model, a built-in or author-built tool, a remote or custom agent,
 * a toolset, a planner and a code executor fail `unsupported`.
 */
export function validateAgentTree(root: unknown, registry: HostRegistry): void {
  let visited = 0;
  const walk = (
    agent: unknown,
    inheritedModel: boolean,
    depth: number,
    path: Set<object>,
  ): void => {
    if (!object(agent)) throw failure('invalid');
    if (depth > MAX_DEPTH || ++visited > MAX_AGENTS || path.has(agent)) throw failure('invalid');
    if (!ALLOWED.has(Object.getPrototypeOf(agent) as object)) throw failure('unsupported');
    let modelKnown = inheritedModel;
    if (agent instanceof LlmAgent) {
      if (agent.model !== undefined) {
        if (!object(agent.model) || !registry.models.has(agent.model)) throw failure('unsupported');
        modelKnown = true;
      }
      // An agent with no model of its own and none above it would fall back to ADK's registry.
      if (!modelKnown) throw failure('unsupported');
      if (agent.codeExecutor !== undefined || agent.planner !== undefined)
        throw failure('unsupported');
      if (!Array.isArray(agent.tools)) throw failure('invalid');
      for (const tool of agent.tools)
        if (!object(tool) || !registry.tools.has(tool)) throw failure('unsupported');
    }
    if (!Array.isArray(agent['subAgents'])) throw failure('invalid');
    path.add(agent);
    for (const child of agent['subAgents']) walk(child, modelKnown, depth + 1, path);
    path.delete(agent);
  };
  walk(root, false, 0, new Set());
}
