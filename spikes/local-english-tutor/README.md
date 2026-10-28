# Spike: a fully local English sentence tutor

Throwaway M0 code (brief §16.2). It checks whether a LangGraph.js agent and [LiquidAI/LFM3-1.7B-ONNX](https://huggingface.co/LiquidAI/LFM3-1.7B-ONNX) on WebGPU can turn one English sentence into a structured lesson entirely in the browser, and what that means for the M1 API. Nothing here becomes package code. The page does not use `packages/core`, which holds draft contract types only.

The learner types a sentence of up to 200 characters or clicks one of seven samples. The agent then writes a lesson for Vietnamese software developers in seven sections:

- `overview`: the tone, a Vietnamese translation and an explanation of the meaning;
- `breakdown`: each word with its US English IPA, its meaning and its grammatical role;
- `pronunciation`: two to four tips for a Vietnamese speaker;
- `phrases`: up to three phrases worth learning;
- `usage`: when to say the sentence, two to four typical situations, and when not to;
- `examples`: three new sentences in the same pattern, with translations;
- `caseStudy`: a short scene at work, with a title, a dialogue of three or four lines that contains the sentence, and a takeaway.

The model writes all of it from the section prompts. The only fixed data is the CMU Pronouncing Dictionary: the agent looks each word up, and the model reviews the transcriptions.

## Run it

Node.js 24 and pnpm 11. This folder is its own pnpm workspace, so the root install and CI do not install its dependencies.

```sh
pnpm install
pnpm start
```

Open http://127.0.0.1:4173/ in Chrome. The page has the origin and the Cache Storage name of `spikes/b0-webgpu-load`, so it reuses a model that the B0 page downloaded. Otherwise it asks before it downloads the same six files, about 1.40 GB, from huggingface.co at revision `189271ef61b9e7fdd4a8b5b0891bcacad37700f8`. As in B0, each file is checked against the size and hash that the Hub lists, whether it comes from the network or from the cache.

When a lesson finishes, the page logs a summary to the console, prefixed `[tutor] lesson`: each section's status, timing, token counts and attempts, the IPA comparison, and the length of each list. The UI text is Vietnamese and lives in `src/ui/strings.ts`.

## What the page does

- **Agent.** A LangGraph.js graph (`@langchain/langgraph/web`) runs on the main thread. Two nodes start together: `lookup`, a deterministic tool that looks up each word in the dictionary, and `overview`. The other six sections wait for both. A section that fails does not stop the others.
- **Prompts.** Each section's prompt is a system message with the section's instruction, a worked example given as an earlier request and its answer, and then the learner's request. The request gives the sentence and, for the six later sections, the overview's translation and meaning. The requests of `breakdown` and `pronunciation` also list the sentence's words with the dictionary's transcriptions. The instructions give list counts in words, such as "two to four tips"; the schemas' bounds are not in the prompts.
- **Model.** `ChatWebGpu` is a LangChain chat model over a module worker, so the graph calls the model as it would call any LangChain provider. The worker keeps B0's session setup and generation loop: onnxruntime-web on WebGPU, caches kept on the GPU between steps, the chat template with `enable_thinking: false`, prefill in chunks of at most 256 tokens, and greedy decoding with a repetition penalty of 1.1. It adds streaming and aborts. It runs one generation at a time, so the sections finish one after another.
- **Structured output.** Each section has a Zod schema. Its JSON Schema (`z.toJSONSchema`) goes to the worker in the `jsonSchema` call option, the way ChatOpenAI takes `response_format`. The worker writes the reply's JSON structure itself: braces, brackets, keys, commas and constants (`src/engine/json-guide.ts`). The model writes the contents of each string, picks the enum value, and decides where each list ends between the schema's `minItems` and `maxItems`. In `breakdown`, the schema is a tuple with the sentence's words as constants, so the worker writes each word too. The page then parses the reply and validates it with Zod; a reply that fails gets one repair attempt. This follows LangChain's ProviderStrategy, with the worker as the provider. The base `withStructuredOutput` in `@langchain/core` 1.2.20 needs `bindTools` and works only through tool calling.
- **Strings.** At each step the worker ranks the 40 likeliest tokens and takes the first whose text fits in a JSON string. Small models often leave the quotation marks around a quoted word unescaped, so the text after an unescaped mark decides whether it ends the string:
  - `}` or `]` ends the string;
  - `,` or `:` ends it unless a quotation is open, that is, unless the string holds an odd number of escaped marks;
  - the end of the token ends it unless a quotation is open or whitespace comes before the mark;
  - anything else makes the mark part of the text, and the worker escapes it.

  A string also ends after 160 model tokens.
- **Token boundaries.** The tokenizer merges JSON punctuation into single tokens, such as `"},{"` and `"}]`. When the model closes a string with such a token, the worker keeps the text after the quotation mark and follows it where the schema allows. The model's choice between another list item and the end of the list then comes from the token it picked.
- **Repetition penalty.** In guided replies the penalty leaves out tokens that contain a quotation mark, so that it does not keep the model from closing a string.
- **IPA.** `lookup` converts the dictionary's ARPAbet to IPA in a US English learner-dictionary style. The model keeps one of the listed transcriptions, corrects it, or writes its own for a word the dictionary lacks. The page shows the model's IPA with a label: it matches the dictionary, the model changed it (with the dictionary's forms shown), or it is the model's own.
- **Speech.** The listen buttons use `speechSynthesis` with voices whose `localService` is true. Other voices may synthesize on a server, so the page never uses them, and it disables the buttons when no local English voice is installed.
- **Network.** The dev server sends a Content-Security-Policy with every response, the worker script included: the page and the worker can connect only to `127.0.0.1:4173`, `huggingface.co` and `*.hf.co`. The only `fetch` in the spike's code downloads the six model files. React renders all model output as text.

## Licenses

- The model weights are under the LFM Open License v1.0, not AGPL-3.0. The page downloads them at run time, and they are not part of this repository.
- The dictionary is the npm package `cmu-pronouncing-dictionary` 3.0.0, under the ISC license, with data from CMUdict, which Carnegie Mellon University publishes under a BSD-style license. It is a dependency and not part of this repository.

## Results

In the three guided runs, every section passed validation on its first reply, and a lesson took 17.9–24.4 s. With free-form JSON and one repair attempt, 13 of 49 sections failed, and a lesson took 34.4–52.5 s.

Run on 2026-10-28 on an Apple M5 Pro (24 GB) with macOS 26.6.2 and Chrome 155.0.8059.86, with onnxruntime-web 1.31.0-dev.20260914-8d85527a0 and one WASM thread. The model came from Cache Storage: reading and checking the six files and creating the session took 1.7 s at one page load and 3.6 s at another.

Each run went through the seven sample sentences in order, 49 sections in all. Each run after the baseline builds on the one before:

| Run | Change | First replies that failed | Sections that failed | Lesson time |
| --- | --- | --- | --- | --- |
| Baseline | Free-form JSON, Zod validation, one repair attempt | 19 of 49 | 13 of 49 | 34.4–52.5 s |
| A | Guided generation | 0 | 0 | 18.0–23.7 s |
| B | The token lookahead and the quotation-mark rules | 0 | 0 | 17.9–24.3 s |
| C | List bounds that match the counts in the instructions | 0 | 0 | 18.2–24.4 s |

Lesson time runs from submitting the sentence to the last section's result. After run C, a typed sentence, "Please review my pull request before the end of the day.", also passed on every first reply, in 22.3 s.

In the baseline:

- 18 first replies did not parse or did not match the schema, and the repair attempt fixed 6 of them. One more section failed on a worker bug, since fixed: decoding an empty token list threw `token_ids must be a non-empty array of integers`.
- `breakdown`, the longest reply, failed in 6 of the 7 lessons.
- `JSON.parse` stopped at object members that did not start with a double-quoted key, at a `//` comment, and where it expected a `:` or a `,`. Other replies held no complete JSON object. Replies that parsed left out keys such as `words`, `ipa`, `examples`, `dialogue` and `takeaway`, or held more than the four tips the schema allowed.
- Which section failed depended on the sentence. Each sentence gives every section a different prompt, and in greedy decoding one different early token changes the rest of the reply.

Section timing in run C. The two time columns are medians over the seven lessons, each taken on its own; the token columns give the range. The six later sections reached the worker in the same order in every lesson: the alphabetical order of their names. A section's own time is the gap since the previous section's result.

| Section | Result after | Own time | Prompt tokens | Reply tokens | Written by the worker |
| --- | --- | --- | --- | --- | --- |
| `overview` | 1.3 s | 1.3 s | 236–241 | 55–81 | 13–14 |
| `breakdown` | 7.2 s | 5.7 s | 994–1,105 | 233–386 | 96–162 |
| `caseStudy` | 11.0 s | 3.7 s | 532–557 | 155–231 | 47–60 |
| `examples` | 13.3 s | 2.2 s | 378–403 | 94–120 | 25–26 |
| `phrases` | 15.3 s | 2.0 s | 426–451 | 54–136 | 17–38 |
| `pronunciation` | 18.4 s | 3.5 s | 781–892 | 105–256 | 21–38 |
| `usage` | 20.5 s | 2.2 s | 387–412 | 94–133 | 16–18 |

- Reply tokens include the structure the worker writes. The model reads that text in one pass before its next choice, so the reply speed, 81.5–112.7 tok/s in run C with a median of 87, does not compare with the baseline's 65.2–85 tok/s of free decoding.
- Every sequence was longer than the 256-token sliding window that B0 stayed inside. The longest, the first sentence's `breakdown`, had a 1,105-token prompt and a 386-token reply: 1,491 tokens. The page passes an attention mask over the whole sequence and leaves the sliding window to the model's ONNX graph, as Transformers.js 4.3.2 does for LFM3. Every reply still passed validation; quality past the window was not scored.

List lengths in runs B and C. The model decides where a list ends, within the schema's bounds:

| List | The instruction asks for | Bounds in B | Lengths in B | Bounds in C | Lengths in C |
| --- | --- | --- | --- | --- | --- |
| Tips | two to four | 1–4 | 4, 3, 1, 2, 2, 4, 3 | 2–4 | 4, 2, 3, 2, 2, 2, 3 |
| Phrases | up to three | 0–4 | 3, 1, 2, 2, 2, 2, 3 | 0–3 | 3, 1, 2, 2, 2, 2, 3 |
| Situations | two to four | 1–5 | 3, 3, 3, 3, 3, 4, 3 | 2–4 | 3, 3, 3, 3, 3, 4, 3 |
| Examples | three | 2–5 | 2 in every lesson | exactly 3 | 3 in every lesson |
| Dialogue lines | three or four | 2–8 | 2, 2, 3, 3, 2, 2, 3 | 3–4 | 3, 3, 4, 3, 3, 3, 3 |

- In run B, `examples` stopped at the minimum of two in every lesson, although the instruction asks for three and the worked example has three. The dialogue stopped at its minimum in 4 of 7 lessons in B and in 6 of 7 in C; the worked example has four lines. The list of plain strings, `situations`, never stopped at its minimum.
- In run C, every list is within the range its instruction asks for.
- Between B and C the tips changed in four lessons. The prompts do not contain the bounds, so the change comes from the worker. In the lesson that had one tip in B, the new minimum added a second, and the model went on to a third. The other three had at least two tips in B, so only the step after the first tip differs: in B the worker could ask the model there whether to add a tip, and in C it writes the next tip's opening without asking. The worker encodes the text it wrote when it next runs the model, so asking splits that text into two runs of tokens, and not asking keeps it in one. The model then reads different tokens, and its greedy choices change from there. This follows from the code and was not traced token by token.

IPA, the same in all three guided runs:

- The model kept a dictionary transcription for 63 of the 65 words.
- It changed one, "as", to /az/, which is not a US English form; the dictionary lists /æz/ and /ez/.
- For "reran", which the dictionary lacks, it wrote /rɪˈrən/; the vowel of the second syllable should be /æ/.
- In the typed sentence it kept all 11.

In these runs the review fixed no transcription, and both transcriptions the model wrote itself are wrong.

Network: the network capture of the Claude in Chrome extension holds 158 requests from the page over four page loads, a period that includes run C and the typed sentence; the typed sentence's lesson added none. All are GET requests to `127.0.0.1:4173` for the page, its modules and the worker script; none went to another host, and none carried a sentence. The page's Resource Timing for the last load agrees: 47 entries, all from `127.0.0.1:4173`. Neither covers the worker's own requests: the onnxruntime-web modules that the worker imports are missing from the capture.

Limits:

- One machine, one browser, eight sentences, one run per configuration, and greedy decoding only.
- Quality is not scored. One read-through of the typed sentence's lesson found errors that a score would have to catch: a tip that gives "please" a long /ɛ/ next to its IPA /pliːz/, grammatical roles that call "the" a pronoun and "request" the object of "request", and an overview and a phrase note that compare the sentence with "before lunch", which comes from the worked example in the prompt.
- The network evidence for the worker is its code, whose only fetches are the six model files, and the Content-Security-Policy.
- Memory use, the listen buttons and the model card's sampling settings were not tested.

## What this means for M1

- **Schema enforcement belongs in the model adapter.** At 1.7B parameters, validating free-form JSON and asking for a repair left 13 of 49 sections failed; enforcing the schema while decoding left none. A local provider that claims the `structured-output` feature (`packages/core/src/models.ts`) should enforce the schema while it decodes. The JSON Schema can travel as a call option, as `response_format` does for hosted providers. The M1 adapter should also override `withStructuredOutput`, so that LangChain code that calls it takes the same path.
- **The guide covers only the schemas the lesson uses**: objects, whose properties it always writes, in order; arrays with `minItems` and `maxItems`, or with `prefixItems`; strings with `minLength`; `enum` and `const`. It throws when it reaches a number, a boolean, null or a union, which can be in the middle of a reply. M1 needs a documented subset that the adapter checks before it generates, or a full grammar engine.
- **Writing structure as text changes the model's tokens.** The worker encodes the structure it wrote when it next runs the model, so where it asks the model changes the token sequence and the reply, which would explain the tips that changed between B and C. Masking the scores to the tokens the schema allows at each step would keep the model's own tokenization, at the cost of a check over the vocabulary at every step.
- **Quotation marks need rules.** Small models leave quotation marks inside strings unescaped. In run A, strings in one lesson were cut off at such a mark. The check for cut-off strings found none in run C, with the rules added in run B. The rules are heuristics and can still misjudge a mark.
- **Counts belong in the schema.** Free to choose, the model often stopped object lists at the schema's minimum, below what the instruction asked for. Bounds that match the instructions kept every count within what they ask. When lessons are scored, by people or by an LLM judge, the schema then sets the list lengths, and the score can rest on the content.
- **One local model serializes the graph.** The six sections that the graph runs in parallel run one after another, in the order they reach the worker, which is not the page's order: `caseStudy`, the last section on the page, finished third, and `pronunciation`, the third, finished sixth. An in-browser engine needs a scheduling policy, for example to finish first the section the learner reads first.
- **Usage metadata.** In `@langchain/core` 1.2.20, the fields of `AIMessageChunk` type `usage_metadata` as `undefined` for the default message structure, so the adapter cannot set it without a cast. The spike reports token counts in `response_metadata.stats`; M1 should report them in `usage_metadata`, where LangChain code looks for them.
- **The model's IPA review added errors, not fixes.** In the seven sample lessons it changed one of 64 dictionary transcriptions, and the change was wrong; both transcriptions it wrote itself were wrong too. A UI that shows a model's review of a tool's output should mark each change and show the original, as this page does.
- **Sequences past 256 tokens run.** Prompts of up to 1,105 tokens and sequences of up to 1,491 tokens ran with the full attention mask, past the 256-token window that B0 stayed inside, and every reply passed validation. Their quality was not scored.
