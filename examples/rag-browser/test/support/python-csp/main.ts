// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import workerUrl from './worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: unknown;
const events: unknown[] = [];
const violations: string[] = [];
Object.assign(globalThis, { pythonCsp: { events, violations } });
addEventListener('securitypolicyviolation', (event) => violations.push(event.effectiveDirective));
const url = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    if (new URL(value, location.href).href !== url) throw new TypeError('Unexpected Worker URL.');
    return url;
  },
});
const worker = new Worker(url, { type: 'module' });
worker.addEventListener('message', (event) => {
  const message = JSON.parse(event.data as string) as Record<string, unknown>;
  // Stream notifications precede the run result; they are neither a reply nor a failure.
  if (message['kind'] === 'notify') return;
  events.push(
    message['type'] === 'violation'
      ? message
      : {
          type: message['ok'] ? (message['op'] === 'result' ? 'result' : 'ready') : 'failed',
          ...((message['payload'] as object) ?? {}),
        },
  );
  if (message['op'] === 'boot' && message['ok'])
    worker.postMessage(
      JSON.stringify({
        v: 'galaxie.bridge/v2',
        kind: 'request',
        id: 'run',
        op: 'run',
        payload: { input: { value: 1 }, steps: 5, threadId: 'csp-test' },
      }),
    );
});
worker.addEventListener('error', () => events.push({ type: 'failed' }));
worker.postMessage(
  JSON.stringify({
    v: 'galaxie.bridge/v2',
    kind: 'request',
    id: 'boot',
    op: 'boot',
    payload: {
      runtimeUrl: new URL('/python/runtime/', location.href).href,
      wheelsUrl: new URL('/python/wheels/', location.href).href,
      localWheels: PYTHON_LOCAL_WHEELS,
      sources: [
        {
          path: 'csp_agent.py',
          text: 'from langgraph.graph import StateGraph, START, END\nfrom galaxie.langgraph import checkpointer\nfrom typing import TypedDict\nclass State(TypedDict):\n    value: int\ndef create_agent():\n    graph = StateGraph(State)\n    graph.add_node("double", lambda state: {"value": state["value"] * 2})\n    graph.add_edge(START, "double")\n    graph.add_edge("double", END)\n    return graph.compile(checkpointer=checkpointer())\n',
        },
      ],
      module: 'csp_agent',
      entry: 'create_agent',
    },
  }),
);
