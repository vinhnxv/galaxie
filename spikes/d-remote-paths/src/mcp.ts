// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { byteLength, digest } from './canonical.js';

export class LimitError extends Error {
  constructor() {
    super('result_limit');
    this.name = 'LimitError';
  }
}

export class PinError extends Error {
  constructor() {
    super('tool_not_approved');
    this.name = 'PinError';
  }
}

export class McpProbe {
  readonly approved = new Map<string, string>();
  readonly current = new Map<string, string>();
  readonly allowlist = new Set(['lesson.lookup', 'progress.record']);
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  wireCap = 32_768;
  parsedCap = 16_384;
  wireRejected = false;
  parsedRejected = false;
  parsedResults = 0;
  deliveredResults = 0;

  constructor(url: string, credential: string) {
    this.client = new Client({ name: 'spike-page', version: '1' }, { capabilities: {} });
    this.transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${credential}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, { ...init, redirect: 'error' });
        if (!response.body) return response;
        const reader = response.body.getReader();
        let bytes = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              const chunk = await reader.read();
              if (chunk.done) {
                controller.close();
                return;
              }
              bytes += chunk.value.byteLength;
              if (bytes > this.wireCap) {
                this.wireRejected = true;
                await reader.cancel();
                controller.error(new LimitError());
                return;
              }
              controller.enqueue(chunk.value);
            } catch {
              controller.error(new LimitError());
            }
          },
          cancel: () => reader.cancel(),
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    // SDK sends -32601 for every unregistered request method. Do not register
    // sampling/elicitation/roots handlers or advertise those capabilities.
    this.client.onerror = () => {};
  }

  async connect(): Promise<{ sessionVisible: boolean; protocolVersion: string | undefined }> {
    // SDK optional sessionId declarations disagree under exactOptionalPropertyTypes.
    await this.client.connect(this.transport as Transport);
    return {
      sessionVisible: Boolean(this.transport.sessionId),
      protocolVersion: this.transport.protocolVersion,
    };
  }

  async listing(): Promise<{ name: string; hash: string; enabled: boolean }[]> {
    const { tools } = await this.client.listTools();
    this.current.clear();
    const rows = [];
    for (const tool of tools) {
      const definition: Record<string, unknown> = {};
      for (const key of [
        'name',
        'title',
        'description',
        'inputSchema',
        'outputSchema',
        'annotations',
      ] as const) {
        if (tool[key] !== undefined) definition[key] = tool[key];
      }
      const hash = await digest(definition);
      this.current.set(tool.name, hash);
      rows.push({
        name: `mcp.lessons.${tool.name}`,
        hash,
        enabled: this.allowlist.has(tool.name) && this.approved.get(tool.name) === hash,
      });
    }
    return rows;
  }

  approve(name: Tool['name']): void {
    const hash = this.current.get(name);
    if (!hash || !this.allowlist.has(name)) throw new PinError();
    this.approved.set(name, hash);
  }

  async call(name: string, size = 8): Promise<{ bytes: number }> {
    await this.listing();
    if (!this.allowlist.has(name) || this.approved.get(name) !== this.current.get(name))
      throw new PinError();
    const result = await this.client.callTool({ name, arguments: { size } }, undefined, {
      timeout: 3000,
    });
    this.parsedResults++;
    const bytes = byteLength(result);
    if (bytes > this.parsedCap) {
      this.parsedRejected = true;
      throw new LimitError();
    }
    this.deliveredResults++;
    return { bytes };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
