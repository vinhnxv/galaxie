// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { parseArgs } from 'node:util';

export interface Choices {
  readonly kinds: readonly string[];
  readonly frameworks: Readonly<Record<string, readonly string[]>>;
}
export interface Request {
  readonly directory?: string;
  readonly kind?: string;
  readonly framework?: string;
  readonly noInstall: boolean;
  readonly help: boolean;
}
export class UsageError extends Error {}

export function usage(choices: Choices): string {
  const frameworks = [...new Set(Object.values(choices.frameworks).flat())].sort();
  return `Usage: create [dir] [kind] [framework] [--kind <kind>] [--framework <framework>] [--no-install]\nValid kinds: ${choices.kinds.join(', ')}.\nValid frameworks: ${frameworks.join(', ')}.\nThe directory must be a relative path with a lowercase npm package name; use . for the current directory.`;
}

export function validateSelection(request: Request, choices: Choices): void {
  if (request.kind !== undefined && !choices.kinds.includes(request.kind))
    throw new UsageError(`Invalid kind. ${usage(choices)}`);
  const frameworks =
    request.kind === undefined
      ? Object.values(choices.frameworks).flat()
      : (choices.frameworks[request.kind] ?? []);
  if (request.framework !== undefined && !frameworks.includes(request.framework))
    throw new UsageError(
      `Invalid framework for this kind. Valid frameworks: ${frameworks.join(', ')}.\n${usage(choices)}`,
    );
}

export function parseArguments(argv: readonly string[], choices: Choices): Request {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...argv],
        strict: true,
        allowPositionals: true,
        tokens: true,
        options: {
          kind: { type: 'string' },
          framework: { type: 'string' },
          'no-install': { type: 'boolean' },
          help: { type: 'boolean' },
        },
      } as const);
    } catch {
      throw new UsageError(`Invalid arguments. ${usage(choices)}`);
    }
  })();
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name))
      throw new UsageError(`A choice was supplied twice. ${usage(choices)}`);
    seen.add(token.name);
  }
  const [directory, kind, framework] = parsed.positionals;
  if (
    parsed.positionals.length > 3 ||
    (kind !== undefined && parsed.values.kind !== undefined) ||
    (framework !== undefined && parsed.values.framework !== undefined)
  )
    throw new UsageError(
      `A choice was supplied twice or too many arguments were given. ${usage(choices)}`,
    );
  const selectedKind = kind ?? parsed.values.kind;
  const selectedFramework = framework ?? parsed.values.framework;
  const request: Request = {
    ...(directory === undefined ? {} : { directory }),
    ...(selectedKind === undefined ? {} : { kind: selectedKind }),
    ...(selectedFramework === undefined ? {} : { framework: selectedFramework }),
    noInstall: parsed.values['no-install'] ?? false,
    help: parsed.values.help ?? false,
  };
  validateSelection(request, choices);
  return request;
}
