// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { TransformersModelRecord } from './model-record.js';
import type { JsonObject, JsonValue } from './protocol.js';

/**
 * Record-declared `hermes` JSON or `xml` function/parameter bodies inside `<tool_call>`
 * blocks (ADR-0021 decisions 10 and 11).
 *
 * Text outside blocks keeps its characters except at a seam: trailing whitespace before a block
 * and leading whitespace after one are dropped, so a whitespace-only run beside a block vanishes.
 * Both the one-shot parse and the streaming splitter apply that rule to the same segments, so any
 * chunking of a reply gives the same text and the same calls.
 */

export const maxToolBlocks = 16;

const open = '<tool_call>';
const close = '</tool_call>';

export interface ParsedToolCall {
  readonly kind: 'call';
  /** The block's position in the reply, counting invalid blocks. */
  readonly index: number;
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export interface InvalidToolBlock {
  readonly kind: 'invalid';
  readonly index: number;
  readonly id: string;
  /** Set only when the block was JSON with a usable `name`. */
  readonly name?: string;
  /** The raw block text, so a downstream output check sees exactly what the model wrote. */
  readonly args: string;
}

export type ToolItem =
  | { readonly kind: 'text'; readonly text: string }
  | ParsedToolCall
  | InvalidToolBlock;

export interface ParsedReply {
  readonly text: string;
  readonly calls: readonly ParsedToolCall[];
  readonly invalid: readonly InvalidToolBlock[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidBlock(raw: string, index: number, name?: string): InvalidToolBlock {
  return {
    kind: 'invalid',
    index,
    id: `call_${index}`,
    ...(name === undefined ? {} : { name }),
    args: raw,
  };
}

/** Markup has no value types; convert only a declared scalar with an exact textual round trip. */
function parameterValue(raw: string, schema: unknown): JsonValue {
  if (!plainObject(schema)) return raw;
  const type = schema['type'];
  if (type === 'boolean' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (type === 'integer' || type === 'number') {
    const value = Number(raw);
    if (
      Number.isFinite(value) &&
      String(value) === raw &&
      (type !== 'integer' || Number.isSafeInteger(value))
    )
      return value;
  }
  return raw;
}

function xmlCall(
  raw: string,
  tools: readonly JsonObject[],
): { name: string; args: JsonObject } | undefined {
  const match = /^\s*<function=([^\s<>=]+)>([\s\S]*?)<\/function>\s*$/.exec(raw);
  if (match === null) return undefined;
  const name = match[1] as string;
  const declaration = tools.find((tool) => {
    const fn = tool['function'];
    return plainObject(fn) && fn['name'] === name;
  })?.['function'];
  const schema = plainObject(declaration) ? declaration['parameters'] : undefined;
  const properties =
    plainObject(schema) && plainObject(schema['properties']) ? schema['properties'] : {};
  const entries: [string, JsonValue][] = [];
  const names = new Set<string>();
  let body = (match[2] as string).trim();
  while (body !== '') {
    const parameter = /^<parameter=([^\s<>=]+)>([\s\S]*?)<\/parameter>/.exec(body);
    if (parameter === null) return undefined;
    const key = parameter[1] as string;
    const value = (parameter[2] as string).trim();
    if (names.has(key) || /<\/?(?:function|parameter|tool_call)(?:[=>\s])/.test(value))
      return undefined;
    names.add(key);
    entries.push([
      key,
      parameterValue(value, Object.hasOwn(properties, key) ? properties[key] : undefined),
    ]);
    body = body.slice(parameter[0].length).trimStart();
  }
  return { name, args: Object.fromEntries(entries) };
}

function blockItem(
  raw: string,
  index: number,
  format: TransformersModelRecord['toolFormat'],
  tools: readonly JsonObject[],
): ParsedToolCall | InvalidToolBlock {
  const id = `call_${index}`;
  const invalid = (name?: string): InvalidToolBlock => invalidBlock(raw, index, name);
  if (index >= maxToolBlocks) return invalid();
  if (format === 'xml') {
    const call = xmlCall(raw, tools);
    return call === undefined ? invalid() : { kind: 'call', index, id, ...call };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!plainObject(value)) return invalid();
  const { name, arguments: args } = value;
  if (typeof name !== 'string' || name === '') return invalid();
  // A call without arguments is a call with none.
  if (args === undefined) return { kind: 'call', index, id, name, args: {} };
  if (!plainObject(args)) return invalid(name);
  return { kind: 'call', index, id, name, args: args as JsonObject };
}

/** The longest suffix of `text` that is a proper prefix of a tag, or 0. */
function partialTagLength(text: string): number {
  let longest = 0;
  for (const tag of [open, close])
    for (let length = Math.min(tag.length - 1, text.length); length > longest; length--)
      if (text.endsWith(tag.slice(0, length))) {
        longest = length;
        break;
      }
  return longest;
}

/** Splits a reply, fed in any chunking, into text, parsed calls and invalid blocks. */
export class ToolBlockSplitter {
  #pending = '';
  #inBlock = false;
  #seam = false;
  #blocks = 0;
  readonly #format: TransformersModelRecord['toolFormat'];
  readonly #tools: readonly JsonObject[];

  constructor(
    format: TransformersModelRecord['toolFormat'] = 'hermes',
    tools: readonly JsonObject[] = [],
  ) {
    this.#format = format;
    this.#tools = tools;
  }

  push(chunk: string): ToolItem[] {
    this.#pending += chunk;
    return this.#drain(false);
  }

  /** Ends the reply: an unterminated block becomes an invalid call and held text is released. */
  finish(): ToolItem[] {
    return this.#drain(true);
  }

  #text(text: string, items: ToolItem[]): void {
    const visible = this.#seam ? text.trimStart() : text;
    if (visible.length === 0) return;
    this.#seam = false;
    items.push({ kind: 'text', text: visible });
  }

  #drain(final: boolean): ToolItem[] {
    const items: ToolItem[] = [];
    for (;;) {
      if (this.#inBlock) {
        const end = this.#pending.indexOf(close);
        if (end === -1) {
          if (final) {
            items.push(invalidBlock(this.#pending, this.#blocks++));
            this.#pending = '';
            this.#inBlock = false;
          }
          return items;
        }
        items.push(
          blockItem(this.#pending.slice(0, end), this.#blocks++, this.#format, this.#tools),
        );
        this.#pending = this.#pending.slice(end + close.length);
        this.#inBlock = false;
        this.#seam = true;
        continue;
      }
      const starts = this.#pending.indexOf(open);
      const stray = this.#pending.indexOf(close);
      if (starts !== -1 && (stray === -1 || starts < stray)) {
        this.#text(this.#pending.slice(0, starts).trimEnd(), items);
        this.#pending = this.#pending.slice(starts + open.length);
        this.#inBlock = true;
        continue;
      }
      if (stray !== -1) {
        this.#text(this.#pending.slice(0, stray).trimEnd(), items);
        // A closing tag with no opener is a malformed block; its raw text is the tag itself.
        items.push(invalidBlock(close, this.#blocks++));
        this.#pending = this.#pending.slice(stray + close.length);
        this.#seam = true;
        continue;
      }
      if (final) {
        this.#text(this.#pending, items);
        this.#pending = '';
        return items;
      }
      // Hold back whatever could still become a tag, and the whitespace before it, because
      // whitespace next to a block is dropped.
      const partial = partialTagLength(this.#pending);
      const body = this.#pending.slice(0, this.#pending.length - partial);
      const hold = body.length - body.trimEnd().length;
      const keep = hold + partial;
      this.#text(this.#pending.slice(0, this.#pending.length - keep), items);
      this.#pending = this.#pending.slice(this.#pending.length - keep);
      return items;
    }
  }
}

/** The one-shot parse of a complete reply. */
export function parseToolBlocks(
  text: string,
  format: TransformersModelRecord['toolFormat'] = 'hermes',
  tools: readonly JsonObject[] = [],
): ParsedReply {
  const splitter = new ToolBlockSplitter(format, tools);
  const items = [...splitter.push(text), ...splitter.finish()];
  return foldItems(items);
}

export function foldItems(items: readonly ToolItem[]): ParsedReply {
  let text = '';
  const calls: ParsedToolCall[] = [];
  const invalid: InvalidToolBlock[] = [];
  for (const item of items) {
    if (item.kind === 'text') text += item.text;
    else if (item.kind === 'call') calls.push(item);
    else invalid.push(item);
  }
  return { text, calls, invalid };
}
