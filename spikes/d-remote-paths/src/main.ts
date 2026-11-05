// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { McpProbe } from './mcp.js';
import { errorObservation, modelProbe, registerCredential, token } from './models.js';

let mcp: McpProbe | undefined;
const probes = {
  modelProbe,
  token,
  connect: async (url: string, credential: string) => {
    await mcp?.close();
    registerCredential(credential);
    mcp = new McpProbe(url, credential);
    return mcp.connect();
  },
  list: async () => mcp?.listing(),
  approve: (name: string) => mcp?.approve(name),
  call: async (size = 8) => {
    if (!mcp) throw new Error('not_connected');
    try {
      return { completed: true, ...(await mcp.call('lesson.lookup', size)) };
    } catch (error) {
      return { completed: false, error: errorObservation(error) };
    }
  },
  caps: (wire: number, parsed: number) => {
    if (mcp) {
      mcp.wireCap = wire;
      mcp.parsedCap = parsed;
    }
  },
  stats: () =>
    mcp
      ? {
          wireRejected: mcp.wireRejected,
          parsedRejected: mcp.parsedRejected,
          parsedResults: mcp.parsedResults,
          deliveredResults: mcp.deliveredResults,
        }
      : null,
  close: async () => mcp?.close(),
};

declare global {
  interface Window {
    probes: typeof probes;
  }
}
window.probes = probes;
document
  .querySelector('output')
  ?.replaceChildren(document.createTextNode('Loopback probes ready.'));
