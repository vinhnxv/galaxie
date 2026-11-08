// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';

/** One finished case in a Vitest JSON report. */
interface ReportCase {
  readonly fullName: string;
  readonly status: string;
}

interface ReportFile {
  readonly name: string;
  readonly assertionResults: readonly ReportCase[];
}

interface Report {
  readonly testResults: readonly ReportFile[];
}

export interface EngineSummary {
  readonly total: number;
  readonly passed: number;
  readonly skipped: number;
  readonly failed: readonly string[];
  /** Failures that are not in the known list: the only ones that fail the run. */
  readonly unexpected: readonly string[];
  /** Known failures that passed this time, so the list can shrink. */
  readonly fixed: readonly string[];
}

/** A case is named by its file relative to the repository and its full test name. */
function caseName(file: string, test: string): string {
  const marker = '/tests/';
  const index = file.indexOf(marker);
  const relative = index === -1 ? file : file.slice(index + 1);
  return `${relative} | ${test}`;
}

export function summarize(report: Report, known: readonly string[]): EngineSummary {
  let total = 0;
  let passed = 0;
  let skipped = 0;
  const failed: string[] = [];
  const passedNames = new Set<string>();
  for (const file of report.testResults) {
    for (const result of file.assertionResults) {
      total++;
      const name = caseName(file.name, result.fullName);
      if (result.status === 'passed') {
        passed++;
        passedNames.add(name);
      } else if (result.status === 'failed') failed.push(name);
      else skipped++;
    }
  }
  const knownSet = new Set(known);
  return {
    total,
    passed,
    skipped,
    failed,
    unexpected: failed.filter((name) => !knownSet.has(name)),
    fixed: known.filter((name) => passedNames.has(name)),
  };
}

function main(): void {
  const [reportPath, engine, knownPath] = process.argv.slice(2);
  if (reportPath === undefined || engine === undefined || knownPath === undefined) {
    console.error(
      'Usage: node scripts/check-browser-engine.ts <report.json> <engine> <known-failures.json>',
    );
    process.exitCode = 2;
    return;
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
  const knownByEngine = JSON.parse(readFileSync(knownPath, 'utf8')) as Record<
    string,
    readonly string[]
  >;
  const summary = summarize(report, knownByEngine[engine] ?? []);
  console.log(
    `${engine}: ${summary.total} cases, ${summary.passed} passed, ${summary.failed.length} failed, ${summary.skipped} skipped.`,
  );
  for (const name of summary.fixed) console.log(`Known failure now passes, remove it: ${name}`);
  if (summary.total === 0) {
    console.error(`${engine}: the report holds no cases, so the browser did not run.`);
    process.exitCode = 1;
    return;
  }
  if (summary.unexpected.length > 0) {
    console.error(`${engine}: failures not in the known list:`);
    for (const name of summary.unexpected) console.error(`  ${name}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) main();
