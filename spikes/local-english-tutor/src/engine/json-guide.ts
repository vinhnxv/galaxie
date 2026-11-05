// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Guided JSON generation: the provider-side schema enforcement that LangChain's ProviderStrategy
// expects from a hosted model, done in this page's own decoding loop. The guide writes the reply's
// JSON structure itself: braces, brackets, keys, commas and constant values. The model writes the
// contents of each string, picks each enum value and decides where an array ends, within the
// schema's bounds. Every reply is therefore well-formed JSON with every key the schema names.

import type { JsonSchema } from './protocol.js';

/** How many of the likeliest next tokens a choice considers. */
export const CANDIDATES = 40;

/** A string ends after this many model tokens, so one value cannot use up the whole reply. */
const MAX_STRING_TOKENS = 160;

/** The characters JSON allows after a backslash. \u is left out, so an escape is one character. */
const ESCAPES = '"\\/bfnrt';

/** The model's scores for the next token. */
export interface NextToken {
  /** The likeliest tokens, best first. */
  readonly ranked: readonly number[];
  score(token: number): number;
}

/** The generation loop, as the guide drives it. */
export interface Decoder {
  /** Appends text the guide writes. The model reads it before it scores the next token. */
  write(text: string): void;
  /** Appends a token the model chose. */
  accept(token: number): void;
  /** Runs the model over everything appended since the last call. */
  next(): Promise<NextToken>;
  /** A token's text on its own, or '' for a special token. */
  textOf(token: number): string;
  encode(text: string): readonly number[];
  readonly eosId: number;
}

/** Writes one JSON value that matches `schema`. */
export async function writeJson(schema: JsonSchema, decoder: Decoder): Promise<void> {
  await new Guide(decoder).value(schema);
}

class Guide {
  readonly #decoder: Decoder;
  /**
   * What the token that closed the last string held after its quote, such as `},{"` or `}]`: how
   * the model would go on. The guide follows it where the schema allows. The tokenizer merges this
   * structure into one token, so the model rarely sees `"}` alone; when the lookahead decides, no
   * model call splits the structure, and the model reads it in the tokens it would have used.
   */
  #lookahead = '';

  constructor(decoder: Decoder) {
    this.#decoder = decoder;
  }

  async value(schema: JsonSchema): Promise<void> {
    if (schema.const !== undefined) {
      this.#write(JSON.stringify(schema.const));
    } else if (schema.enum !== undefined) {
      await this.#option(schema.enum);
    } else if (schema.type === 'object') {
      await this.#object(schema.properties ?? {});
    } else if (schema.type === 'array') {
      await this.#array(schema);
    } else if (schema.type === 'string') {
      await this.#string(schema.minLength ?? 0);
    } else {
      throw new Error(`guided generation does not support the schema ${JSON.stringify(schema)}`);
    }
  }

  /** Writes structure, and drops the part of the lookahead it covers, or all of it if they differ. */
  #write(text: string): void {
    const ahead = this.#lookahead.trimStart();
    this.#lookahead = ahead.startsWith(text) ? ahead.slice(text.length) : '';
    this.#decoder.write(text);
  }

  // Every property is written, in the schema's order: the lesson's schemas have no optional keys.
  async #object(properties: { readonly [key: string]: JsonSchema }): Promise<void> {
    let separator = '{';
    for (const [key, value] of Object.entries(properties)) {
      this.#write(`${separator}${JSON.stringify(key)}:`);
      await this.value(value);
      separator = ',';
    }
    this.#write(separator === '{' ? '{}' : '}');
  }

  async #array(schema: JsonSchema): Promise<void> {
    if (schema.prefixItems !== undefined) {
      let separator = '[';
      for (const item of schema.prefixItems) {
        this.#write(separator);
        await this.value(item);
        separator = ',';
      }
      this.#write(separator === '[' ? '[]' : ']');
      return;
    }
    const item = schema.items;
    if (typeof item !== 'object') {
      throw new Error('guided generation needs an item schema for an array');
    }
    const min = schema.minItems ?? 0;
    const max = schema.maxItems ?? Number.POSITIVE_INFINITY;
    this.#write('[');
    for (let count = 0; count < max; count++) {
      if (count >= min && !(await this.#wantsItem(count === 0 ? openingOf(item) : ','))) {
        break;
      }
      if (count > 0) {
        this.#write(',');
      }
      await this.value(item);
    }
    this.#write(']');
  }

  /** Whether the model would rather go on with `continuation` than close the array. */
  async #wantsItem(continuation: string): Promise<boolean> {
    const ahead = this.#lookahead.trimStart();
    if (ahead.startsWith(continuation) || ahead.startsWith(']')) {
      return ahead.startsWith(continuation);
    }
    for (const token of (await this.#decoder.next()).ranked) {
      const text = this.#decoder.textOf(token).trimStart();
      if (text.startsWith(continuation)) {
        return true;
      }
      if (text.startsWith(']')) {
        return false;
      }
    }
    return false;
  }

  // Options are told apart by their first token. Options that share it are told apart by order
  // only; the lesson's one enum has none.
  async #option(options: readonly string[]): Promise<void> {
    this.#write('"');
    const next = await this.#decoder.next();
    let best: string | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const option of options) {
      const first = this.#decoder.encode(option)[0];
      const score = first === undefined ? Number.NEGATIVE_INFINITY : next.score(first);
      if (best === undefined || score > bestScore) {
        best = option;
        bestScore = score;
      }
    }
    if (best === undefined) {
      throw new Error('an enum needs at least one value');
    }
    // The opening quote is already written.
    this.#write(JSON.stringify(best).slice(1));
  }

  async #string(minLength: number): Promise<void> {
    this.#write('"');
    const decoder = this.#decoder;
    let content = '';
    let escaping = false;
    let end: StringEnd = { before: '', after: '' };
    for (let count = 0; count < MAX_STRING_TOKENS; count++) {
      const step = stringStep((await decoder.next()).ranked, decoder, content, escaping, minLength);
      if (step.kind === 'end') {
        end = step;
        break;
      }
      if (step.kind === 'token') {
        decoder.accept(step.token);
        content += decoder.textOf(step.token);
      } else {
        decoder.write(step.text);
        content += step.text;
      }
      escaping = step.escaping;
    }
    // A string cut off inside an escape gets a second backslash, so that the reply still parses.
    decoder.write(`${escaping && end.before === '' ? '\\' : ''}${end.before}"`);
    this.#lookahead = end.after;
  }
}

const openingOf = (schema: JsonSchema): string =>
  schema.type === 'object' ? '{' : schema.type === 'array' ? '[' : '"';

/** The text a string's closing token holds on each side of its quote, as in `."` or `"},{"`. */
interface StringEnd {
  readonly before: string;
  readonly after: string;
}

type StringStep =
  | { readonly kind: 'token'; readonly token: number; readonly escaping: boolean }
  /** A token whose quotation marks belong to the text, written with the marks escaped. */
  | { readonly kind: 'text'; readonly text: string; readonly escaping: boolean }
  | ({ readonly kind: 'end' } & StringEnd);

/** The likeliest token that continues the string, or the end of the string. */
function stringStep(
  ranked: readonly number[],
  decoder: Decoder,
  content: string,
  escaping: boolean,
  minLength: number,
): StringStep {
  const longEnough = (text: string): boolean => text.trim().length >= minLength;
  for (const token of ranked) {
    if (token === decoder.eosId) {
      if (!escaping && longEnough(content)) {
        return { kind: 'end', before: '', after: '' };
      }
      continue;
    }
    const text = decoder.textOf(token);
    const scan = text === '' ? undefined : scanInString(text, escaping);
    if (scan === undefined) {
      continue;
    }
    if (scan.quote === undefined) {
      return { kind: 'token', token, escaping: scan.escaping };
    }
    const before = text.slice(0, scan.quote);
    const after = text.slice(scan.quote + 1);
    if (!closesString(content + before, after)) {
      if (scan.escaped !== undefined) {
        return { kind: 'text', text: scan.escaped, escaping: scan.escaping };
      }
    } else if (longEnough(content + before)) {
      return { kind: 'end', before, after };
    }
  }
  // No candidate fits inside a JSON string.
  return { kind: 'end', before: '', after: '' };
}

/**
 * Whether an unescaped quotation mark after `text` ends the string, or belongs to the text: small
 * models often forget to escape the marks around a quoted word. JSON allows only `,`, `}`, `]` or
 * `:` after a string, so other text after the mark means it belongs to the text, and so does a
 * space before it, which opens a quotation. A mark followed by `,` or nothing ends a quotation if
 * one is open, that is if the text holds an odd number of escaped marks.
 */
function closesString(text: string, after: string): boolean {
  const next = after.trimStart();
  if (next.startsWith('}') || next.startsWith(']')) {
    return true;
  }
  const quoting = (text.match(/\\"/g)?.length ?? 0) % 2 === 1;
  if (next.startsWith(',') || next.startsWith(':')) {
    return !quoting;
  }
  return next === '' && !quoting && !/\s$/.test(text);
}

interface Scan {
  /** Where the first unescaped quotation mark is, if there is one. */
  readonly quote: number | undefined;
  /** The text with its unescaped quotation marks escaped, if all of it can go in a string. */
  readonly escaped: string | undefined;
  /** Whether a backslash escape is open after the escaped text. */
  readonly escaping: boolean;
}

/**
 * How `text` goes on inside a JSON string, given whether a backslash escape is open. Undefined if
 * it cannot: the text before the first unescaped quotation mark must fit in a string, and the text
 * after it must too for the mark to be escaped rather than end the string.
 */
function scanInString(text: string, escaping: boolean): Scan | undefined {
  let open = escaping;
  let escaped = '';
  let quote: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (open ? !ESCAPES.includes(char) : char < ' ') {
      return quote === undefined ? undefined : { quote, escaped: undefined, escaping: false };
    }
    if (open) {
      open = false;
    } else if (char === '"') {
      quote ??= i;
      escaped += '\\';
    } else {
      open = char === '\\';
    }
    escaped += char;
  }
  return { quote, escaped, escaping: open };
}
