// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Decides whether a pull request can skip the Python test jobs. A change confined to the paths
// below cannot change a Python result: no Python test reads them. Every other path, an empty list
// and any doubt run the Python jobs, so the filter can only err toward running more.

import { createInterface } from 'node:readline';

const independent: readonly RegExp[] = [
  /^docs\//,
  /\.md$/,
  /^llms\.txt$/,
  /^LICENSE/,
  /^go\//,
  /^packages\/adapter-go\//,
  /^packages\/tools-mcp\//,
  /^packages\/eslint-plugin\//,
  /^examples\/(?:host-local|host-remote|mcp-server|english-tutor)\//,
  /^tests\/conformance\/.*adk-go/,
];

/** True when any changed file can affect a Python test, or when no file is known. */
export function pythonAffected(files: readonly string[]): boolean {
  const changed = files.map((file) => file.trim()).filter((file) => file !== '');
  return (
    changed.length === 0 || changed.some((file) => !independent.some((rule) => rule.test(file)))
  );
}

if (import.meta.main) {
  const files: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) files.push(line);
  console.log(`python=${pythonAffected(files)}`);
}
