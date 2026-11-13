# Asking the user for input with Google ADK

Use an ordinary-name long-running capability tool and an author-owned validating
resume hook where the executor supports it. The recorded outcome for native
`adk_request_input` is different on each executor:

| Executor | Recorded outcome | What to write |
| --- | --- | --- |
| `adk-js` | **REFUSED** as a native-input mapping | An ordinary-name long-running tool works. The reserved-name gate still fails: a capability tool named `adk_request_input` runs its read capability, then fails `unsupported` without an answerable interaction. |
| `adk-python` | **ALTERNATIVE** | `capability_tool(..., long_running=True)`, an `interaction` hook and a validating `resume`. |
| `adk-go` | **REFUSED** by source fact | The pinned ADK Go module has no request-input tool. No replacement for this shape was measured. |

See the [recorded input gates](../adr/0020-google-adk-through-an-adapter.md#confirmation-beside-calls-and-request-input-spike-2026-11).
These examples ask for a city using the read capability `question.ask@1`.
Its placeholder result is `{ pending: true }`; the city arrives later through
the interaction answer, rather than from another capability invocation.

## Host binding and answer

Pass `questionDefinition` to `runtime.create`, select the JavaScript factory
below as `agent`, and bind `question.ask@1` to `questionBinding`.
The host also supplies its routed `answer` model implementation and model policy.
See [host integration](host-integration.md) for runtime construction.

Render `app.CityQuestion/v1` using the host's component registry and validated
props. On the user's submit action, call `answerCity` with the interaction event's
pending value and the current run ID. Core checks the identity fields before
accepting the submission. An accepted dispatch receipt means the submission was
accepted; the subsequent run events determine whether the author accepted its
payload.

<!-- snippet: input-host-js -->
```ts
import {
  type AgentDefinition,
  type AgentInstance,
  type CapabilityBinding,
  type DispatchReceipt,
  defineAgentDefinition,
  type PendingInteraction,
  type RunId,
} from '@galaxie-ai/core';
import { z } from 'zod';

export const questionDefinition: AgentDefinition = defineAgentDefinition({
  id: 'examples/adk-city',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'question.ask@1': {
        kind: 'read',
        input: z.object({ message: z.string() }),
        output: z.object({ pending: z.boolean() }),
      },
    },
  },
});

export const questionBinding: CapabilityBinding = {
  kind: 'read',
  destination: 'in-browser',
  timeoutMs: 1000,
  concurrency: 1,
  grantScope: 'instance',
  approval: 'none',
  retry: 'none',
  async invoke() {
    return { pending: true };
  },
};

export function answerCity(
  instance: Pick<AgentInstance<unknown, unknown>, 'instanceId' | 'dispatch'>,
  runId: RunId,
  pending: PendingInteraction,
  city: string,
): Promise<DispatchReceipt> {
  return instance.dispatch({
    instanceId: instance.instanceId,
    runId,
    interactionId: pending.interactionId,
    surfaceId: pending.surfaceId,
    viewRevision: pending.viewRevision,
    action: 'submit',
    payload: { city },
  });
}
```

This host module is executed against `adk-js` in the
[JavaScript guide tests](../../packages/adapter-adk/test/author-guides.test.ts).
It uses core APIs, but has not been run with the Python agent below. A Python host
must use its Python executor definition and Worker setup; see the
[Python adapter](../../packages/adapter-pyodide/README.md#google-adk-python-agents).

## JavaScript agent

Build the model and tool inside the factory. `interaction` exposes positional
requests without ADK call IDs. The long-running tool invokes the read capability
once, pauses, and receives the validated city as its tool response on resume.

<!-- snippet: input-agent-js -->
```ts
import { GalaxieError } from '@galaxie-ai/core';
import { LlmAgent } from '@google/adk';
import { z } from 'zod';
import { type AdkAgent, defineAdkEntry } from '@galaxie-ai/adapter-adk';

export const inputAgent: AdkAgent = (host) =>
  defineAdkEntry({
    agent: new LlmAgent({
      name: 'root',
      model: host.adk.llm('answer'),
      tools: [
        host.adk.capabilityTool('question.ask@1', {
          toolName: 'ask_city',
          description: 'Ask which city to use.',
          parameters: z.object({ message: z.string() }),
          longRunning: true,
        }),
      ],
    }),
    interaction(requests) {
      return {
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'app.CityQuestion/v1',
        props: { requests },
      };
    },
    resume(requests, action, payload) {
      const answer = z.strictObject({ city: z.string().min(1) }).safeParse(payload);
      if (action !== 'submit' || !answer.success)
        throw new GalaxieError('invalid', 'The city answer must be valid.');
      return requests.map(() => ({ response: answer.data }));
    },
  });
```

The scripted test calls `ask_city` with `{ message: 'Which city?' }`, checks
the published request and supplies `{ city: 'Hue' }`. The next model request
contains the tool message `{"city":"Hue"}` and finishes with `finished`;
the capability is still invoked only once. Each of `{}`, `{ city: 1 }`,
`{ city: '' }` and `{ city: 'Hue', extra: true }` ends the resumed run with
`invalid` before another model request. Retry after an invalid JavaScript
answer is not measured by this example.

`host.adk.requestInput()` fails `unsupported` with no capability invocation.
Naming a capability tool `adk_request_input` is worse: it is admitted and its
read runs before the reserved-name failure. Use `ask_city`.

## Python agent

The entry factory creates the tool and model for this interpreter. This agent
half uses the same question and answer shape:

<!-- snippet: input-agent-py -->
```python
from google.adk.agents import LlmAgent

from galaxie import GalaxieError
from galaxie.adk import Executor, capability_tool, llm


def interaction(requests):
    return {
        'surfaceId': 'main',
        'viewRevision': 'r1',
        'component': 'app.CityQuestion/v1',
        'props': {'requests': requests},
    }


def resume(requests, action, payload):
    if (action != 'submit' or type(payload) is not dict
            or set(payload) != {'city'} or type(payload['city']) is not str
            or not payload['city']):
        raise GalaxieError('invalid')
    return [{'response': payload} for _ in requests]


def create():
    question = capability_tool(
        'ask_city', 'question.ask@1',
        {'type': 'object', 'properties': {'message': {'type': 'string'}},
         'required': ['message']},
        'Ask for a city.', long_running=True,
    )
    agent = LlmAgent(name='root', model=llm('answer'), tools=[question])
    return Executor(agent, interaction=interaction, resume=resume)
```

The [CPython guide tests](../../python/galaxie/tests/test_adk_author_guides.py)
run this factory with a scripted bridge, both live and after byte-checkpoint
restore into a fresh executor. All four malformed city payloads above fail
`invalid`, preserve the original pending interaction and send no new bridge
message. A valid answer then reaches the model as `{"city":"Hue"}` and
finishes with `finished`.

Python's recorded reserved-name test also succeeds live and after restore.
Use an ordinary name anyway so the example can be ported to JavaScript.
This does not change JavaScript's **REFUSED** outcome.

## Rules for authors

- Validate the action and answer in your own `resume`. The default resume
  handles confirmations, not arbitrary long-running answers.
- Answer every pending request at once, with one decision per request in order.
  This single-question example maps the one validated city to its request.
  Multiple different questions need their own answer validation.
- Do not name a capability tool `adk_request_input`.
- A confirmation beside a long-running call stays refused. A question answer
  never substitutes for a host-rendered write confirmation.
- Respect the executor's existing tree-position pause rules:
  [JavaScript](../../packages/adapter-adk/README.md#pauses-and-resume),
  [Python](../../packages/adapter-pyodide/README.md#asking-for-input) and
  [Go](../../packages/adapter-go/README.md#interactions).

A pause ends the executor invocation; the answer starts another invocation in
the same conversation. The host continues through `instance.dispatch` and
`instance.events`. Authors return tool-response data from `resume`.

## Go and evidence limits

ADK Go 1.9.0 has no `adk_request_input` or `request_input` tool. The
[recorded source fact](../adr/0020-google-adk-through-an-adapter.md#confirmation-beside-calls-and-request-input-spike-2026-11)
does not establish a Go input replacement. There is no Go input snippet here;
the adapter's general long-running pause contract is linked above.

The JavaScript agent and host snippets run on Node and headless Chromium with
scripted models. The Python input snippet has CPython-only scripted-bridge
evidence, including restore; a dedicated Chromium/Worker run of this input
shape remains unmeasured. Firefox, WebKit, real models and devices remain
unmeasured for these examples. The
[snippet equality test](../../tests/conformance/adk-author-guides.node.test.ts)
checks every executable code block against its test-owned source.

For model and tool migrations, read [ADK models and tools](adk-models-and-tools.md).
