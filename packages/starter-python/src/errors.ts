// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export const invalidArtifact = 'The Python starter artifact could not be verified.';

export function invalidWheel(file: string): string {
  return `The Python starter wheel could not be verified: ${file}.`;
}
