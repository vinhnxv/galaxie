// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { requestInteraction } from '@galaxie/adapter-langgraph';
import { IndexedDBSaver } from '@galaxie/storage-indexeddb';
import {
  Annotation,
  type BaseCheckpointSaver,
  Command,
  END,
  type LangGraphRunnableConfig,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, onTestFinished, test } from 'vitest';
import { installContext } from '../../packages/adapter-langgraph/src/interaction.js';

for (const mode of ['resume', 'rebuild', 'indexeddb'] as const) {
  test.skipIf(mode === 'indexeddb' && typeof indexedDB === 'undefined')(
    `LangGraph task namespaces survive ${mode} before effect scoping is enabled`,
    async () => {
      installContext();
      const databaseName = `galaxie-task-scope-${crypto.randomUUID()}`;
      const open = () =>
        IndexedDBSaver.open({ databaseName, appId: 'task-scope', principalScope: 'test' });
      let saver: BaseCheckpointSaver = mode === 'indexeddb' ? await open() : new MemorySaver();
      onTestFinished(async () => {
        if (saver instanceof IndexedDBSaver) {
          saver.close();
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase(databaseName);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Task scope cleanup was blocked.'));
          });
        }
      });
      const scopes = { parent: [] as string[], child: [] as string[] };
      const observe = (node: keyof typeof scopes, config: LangGraphRunnableConfig): void => {
        const scope = config.metadata?.['langgraph_checkpoint_ns'];
        expect(scope).toEqual(expect.stringMatching(/:[0-9a-f-]{36}$/));
        // The configurable namespace may name the enclosing graph; metadata names the task.
        if (typeof scope !== 'string') throw new Error('Expected a task namespace.');
        scopes[node].push(scope);
      };
      const state = Annotation.Root({ answer: Annotation<unknown> });
      const build = () => {
        const child = new StateGraph(state)
          .addNode('ask', async (_value, config) => {
            observe('child', config);
            await Promise.resolve();
            return {
              answer: requestInteraction(
                {
                  surfaceId: 'main',
                  viewRevision: 'r1',
                  component: 'conformance.Question/v1',
                  props: {},
                },
                config,
              ).payload,
            };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile();
        return new StateGraph(state)
          .addNode('parent', async (value, config) => {
            observe('parent', config);
            return child.invoke(value, config);
          })
          .addEdge(START, 'parent')
          .addEdge('parent', END)
          .compile({ checkpointer: saver });
      };
      let graph = build();
      const config = { configurable: { thread_id: crypto.randomUUID() } };
      await graph.invoke({}, config);
      const pending = await graph.getState(config);
      const task = pending.tasks[0];
      const interruptId = task?.interrupts[0]?.id;
      if (task === undefined || interruptId === undefined)
        throw new Error('Expected the pending parent task and child interrupt.');
      expect(scopes.parent).toEqual([`parent:${task.id}`]);
      expect(scopes.child[0]).toEqual(expect.stringContaining(`${scopes.parent[0]}|ask:`));
      if (mode !== 'resume') {
        if (saver instanceof IndexedDBSaver) {
          saver.close();
          saver = await open();
        }
        graph = build();
        expect((await graph.getState(config)).tasks[0]?.id).toBe(task.id);
      }
      expect(
        await graph.invoke(
          new Command({ resume: { [interruptId]: { action: 'submit', payload: 'continued' } } }),
          config,
        ),
      ).toEqual({ answer: 'continued' });
      expect(scopes.parent).toEqual([`parent:${task.id}`, `parent:${task.id}`]);
      expect(scopes.child).toHaveLength(2);
      expect(scopes.child[1]).toBe(scopes.child[0]);
    },
  );
}
