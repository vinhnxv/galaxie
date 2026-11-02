# @galaxie/eslint-plugin

ESLint 10 flat-config rules for reviewed, bundled agent packages. The plugin has zero runtime dependencies, uses ESTree and scope analysis without type information, and never executes the code it lints. Every recommended rule is an error; none has an autofix.

```js
import galaxie from '@galaxie/eslint-plugin';

export default [galaxie.configs.recommended];
```

Apply this config to agent packages. Hosts legitimately own network, storage and rendering APIs. This repository keeps Biome as its linter and tests the plugin separately; it does not apply these rules to host or runtime packages.

TypeScript sources need a TypeScript-capable parser such as `typescript-eslint`, configured with a `files: ['**/*.ts']` pattern so ESLint includes them. Under [ADR-0013](../../docs/adr/0013-typescript-first-implementation.md), compiler-API tools such as that parser run on TypeScript 6. This repository does not install or test that parser: RuleTester uses ESLint's default espree parser with JSX enabled, and the Node tutor conformance test uses Node 24's `stripTypeScriptTypes` before linting the real `.ts` paths.

| Rule | Reports | Use instead |
| --- | --- | --- |
| `galaxie/no-direct-network` | References to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `RTCPeerConnection`, `navigator.sendBeacon` and `importScripts`, including calls and construction | A host-bound capability |
| `galaxie/no-direct-storage` | References to `localStorage`, `sessionStorage`, `indexedDB`, `caches`, `cookieStore`, `document.cookie` and `navigator.storage` | Host-owned storage and checkpoints |
| `galaxie/no-dom` | References to `document`, `window`, `DOMParser`, `HTMLElement` and other `navigator` access; dynamic keys on global objects; HTML sinks | The host's UI catalog; model-produced props rendered as React text |
| `galaxie/no-eval` | Global `eval` and `Function` references, including indirect calls; string or template arguments to `setTimeout`, `setInterval` and `setImmediate`; non-string-literal dynamic imports | Reviewed, bundled code and function callbacks |
| `galaxie/no-direct-model` | Model-provider imports, re-exports, literal dynamic imports and global `LanguageModel` references; the ADK model classes `Gemini`, `ApigeeLlm`, `ChromeBuiltInLlm`, `LLMRegistry` and `RoutedLlm` | `host.langchain.chatModel(role)`, or `host.adk.llm(role)` for ADK agents, so routing, labels, consent and budgets apply |

Global checks respect local variables, parameters and imports that shadow platform names. Static member forms such as `self['fetch']` and chains such as `globalThis.window.fetch` are recognized on unshadowed `globalThis`, `window`, `self` and `global`. `no-dom` owns the `dynamicGlobal` report for non-static global keys, so the recommended config reports each such access once. DOM reports omit accesses already covered by the network and storage rules, and HTML sinks get their own message.

HTML sinks include assignments to `innerHTML`, `outerHTML` and `srcdoc`, calls to `insertAdjacentHTML` and `createContextualFragment` on any receiver, global `document.write` and `document.writeln`, and the JSX attribute `dangerouslySetInnerHTML`. Render model output as text through trusted catalog components.

`no-direct-model` matches these sources and their subpaths: `@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`, `@langchain/ollama`, `@langchain/mistralai`, `@langchain/groq`, `@langchain/community`, `@mlc-ai/web-llm`, `@google/genai`, `openai`, `@anthropic-ai/sdk` and `@galaxie/models`. It matches only the model classes of `@google/adk` listed above, as named imports, re-exports and member access on a namespace import (`adk.Gemini`); the rest of that package is allowed because ADK agents and tools are validated at prepare. Its optional object has `allow?: string[]` and `extraSources?: string[]`. Each item is an exact package or subpath prefix, without wildcards or a trailing slash: `openai` matches `openai` and `openai/subpath`, but not `openai-other`. `extraSources` adds prefixes; `allow` exempts a matching source and its subpaths, including extra sources. An exemption permits direct construction to bypass the router, so review it explicitly. These options do not exempt the global `LanguageModel`.

Reports contain only matched API names or configured source prefixes, never call arguments, string contents or full source text.

## Limits

This is a linting aid, not a sandbox. It provides no runtime enforcement. Without type information or data-flow analysis, aliases and re-exports can escape detection: `const f = fetch` is caught at the direct reference, but `const g = globalThis; g.fetch()` is not. Values supplied by dependencies and runtime-built code can also escape it. The generic HTML-sink checks match names on any receiver and cannot determine whether the value came from a model.

Use the rules alongside code review, host policy, backend authorization and the [mandatory baseline](../../docs/adr/0012-security-baseline.md). Runtime controls apply only on SDK-controlled paths; trusted agent code and same-origin dependencies can bypass them.
