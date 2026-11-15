// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { type Choices, type Request, UsageError, usage, validateSelection } from './args.js';

export async function prompt(
  request: Request,
  choices: Choices,
  input: Readable,
  output: Writable,
): Promise<Request & { directory: string; kind: string; framework: string }> {
  const readline = createInterface({ input, output, terminal: false });
  const lines = readline[Symbol.asyncIterator]();
  const ask = async (label: string, valid?: readonly string[]): Promise<string> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      output.write(
        `${label}${valid === undefined ? '' : ` (${valid.map((value, index) => `${index + 1}: ${value}`).join(', ')})`}: `,
      );
      const line = await lines.next();
      if (line.done)
        throw new UsageError(`Input ended before a choice was made. ${usage(choices)}`);
      const answer = line.value.trim();
      if (valid === undefined) {
        if (answer !== '') return answer;
      } else {
        if (answer === '' && valid.length === 1) return valid[0] as string;
        if (valid.includes(answer)) return answer;
        if (/^[1-9]\d*$/.test(answer)) {
          const indexed = valid[Number(answer) - 1];
          if (indexed !== undefined) return indexed;
        }
      }
      output.write('Please enter one of the listed choices.\n');
    }
    throw new UsageError(`No valid choice after three answers. ${usage(choices)}`);
  };
  try {
    const directory = request.directory ?? (await ask('Project directory'));
    const kind = request.kind ?? (await ask('Kind', choices.kinds));
    const selected = { ...request, directory, kind };
    validateSelection(selected, choices);
    const framework = request.framework ?? (await ask('Framework', choices.frameworks[kind] ?? []));
    return { ...selected, framework };
  } finally {
    readline.close();
  }
}
