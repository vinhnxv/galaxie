// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { GalaxieError } from '@galaxie-ai/core';
import { LlmAgent } from '@google/adk';
import { z } from 'zod';
import { type AdkAgent, defineAdkEntry } from '../../src/index.js';

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
