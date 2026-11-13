// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { LlmAgent, LoopAgent, ParallelAgent, SequentialAgent } from '@google/adk';
import { failure } from './errors.js';
import type { HostRegistry } from './host.js';
import { fixedToolsetMembers } from './host.js';

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
 * an unregistered toolset, a planner and a code executor fail `unsupported`.
 */
type ProcessorField = 'contextCompactors' | 'requestProcessors' | 'responseProcessors';

/** The prototypes of the processors ADK itself puts on every LlmAgent. */
const BASELINE = new LlmAgent({ name: 'baseline', model: 'baseline' });

function defaultsOnly(agent: LlmAgent, field: ProcessorField): boolean {
  const value: unknown = Reflect.get(agent, field);
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const allowed = new Set<unknown>(
    ((Reflect.get(BASELINE, field) as unknown[] | undefined) ?? []).map((entry) =>
      Object.getPrototypeOf(entry),
    ),
  );
  return value.every(
    (entry: unknown) => object(entry) && allowed.has(Object.getPrototypeOf(entry)),
  );
}

export function validateAgentTree(root: unknown, registry: HostRegistry): void {
  let visited = 0;
  const names = new Map<unknown, number>();
  const walk = (
    agent: unknown,
    inheritedModel: boolean,
    depth: number,
    path: Set<object>,
  ): void => {
    if (!object(agent)) throw failure('invalid');
    if (depth > MAX_DEPTH || ++visited > MAX_AGENTS || path.has(agent)) throw failure('invalid');
    if (!ALLOWED.has(Object.getPrototypeOf(agent) as object)) throw failure('unsupported');
    names.set(agent['name'], (names.get(agent['name']) ?? 0) + 1);
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
      // Compactors and added processors can hold their own models or run author code on each
      // request; only the processors a bare LlmAgent already carries are ADK's own.
      if (!defaultsOnly(agent, 'contextCompactors') || !defaultsOnly(agent, 'requestProcessors'))
        throw failure('unsupported');
      if (!defaultsOnly(agent, 'responseProcessors')) throw failure('unsupported');
      if (!Array.isArray(agent.tools)) throw failure('invalid');
      const names = new Set<string>();
      const grouped = agent.tools.some((tool) => object(tool) && registry.toolsets?.has(tool));
      for (const tool of agent.tools) {
        if (!object(tool)) throw failure('unsupported');
        const members = fixedToolsetMembers(tool, registry);
        if (members === undefined && !registry.tools.has(tool)) throw failure('unsupported');
        for (const member of members ?? [tool]) {
          if (!registry.tools.has(member)) throw failure('unsupported');
          const name = member.name as string;
          if (grouped && names.has(name)) throw failure('unsupported');
          names.add(name);
        }
      }
    }
    if (!Array.isArray(agent['subAgents'])) throw failure('invalid');
    path.add(agent);
    for (const child of agent['subAgents']) walk(child, modelKnown, depth + 1, path);
    path.delete(agent);
  };
  walk(root, false, 0, new Set());
  if ([...names.values()].some((count) => count > 1)) throw failure('unsupported');
}
