// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { type Choices, parseArguments, UsageError, usage } from './args.js';
import { compose, LayerCollisionError, SelectionError } from './compose.js';
import { GuidanceError, loadGuidanceSource, renderGuidance } from './guidance.js';
import { detectPackageManager, InstallError, type InstallRunner, install } from './install.js';
import { LayerManifestError, loadLayers } from './layers.js';
import { MergeConflictError } from './merge.js';
import { resolveTarballs, TarballError } from './packages.js';
import { assetRoot, ProjectPathError, projectName, validateTarget } from './paths.js';
import { prompt } from './prompt.js';
import { ProjectWriteError, planWrite, writeProject } from './write.js';

export interface IO {
  readonly cwd?: string;
  readonly templatesRoot?: string;
  readonly guidanceRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly stdin?: Readable & { readonly isTTY?: boolean };
  readonly stdout?: Writable & { readonly isTTY?: boolean };
  readonly stderr?: Writable;
  readonly runner?: InstallRunner;
}

export async function run(argv: readonly string[], io: IO = {}): Promise<number> {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;
  const errorOutput = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  let step = 'read the create version';
  try {
    if (argv.length === 1 && argv[0] === '--version') {
      const manifest = JSON.parse(
        await readFile(new URL('../package.json', import.meta.url), 'utf8'),
      ) as { version: string };
      output.write(`${manifest.version}\n`);
      return 0;
    }
    step = 'load template layers';
    const layers = await loadLayers(io.templatesRoot ?? assetRoot('templates'));
    const choices: Choices = {
      kinds: layers
        .filter((layer) => layer.manifest.type === 'kind')
        .map((layer) => layer.manifest.id),
      frameworks: Object.fromEntries(
        layers
          .filter((layer) => layer.manifest.type === 'kind')
          .map((layer) => [layer.manifest.id, layer.manifest.frameworks ?? []]),
      ),
    };
    step = 'parse arguments';
    let request = parseArguments(argv, choices);
    if (request.help) {
      output.write(`${usage(choices)}\n`);
      return 0;
    }
    if (
      request.directory === undefined ||
      request.kind === undefined ||
      request.framework === undefined
    ) {
      if (!input.isTTY || !output.isTTY)
        throw new UsageError(
          `A directory, kind and framework are required without a TTY. ${usage(choices)}`,
        );
      step = 'prompt for project choices';
      request = await prompt(request, choices, input, output);
    }
    step = 'validate the project target';
    const directory = request.directory as string;
    if (isAbsolute(directory) || /^[a-zA-Z]:/.test(directory))
      throw new UsageError(`The project directory must be relative. ${usage(choices)}`);
    validateTarget(directory);
    const target = resolve(io.cwd ?? process.cwd(), directory);
    const name = projectName(target);
    const { packageManager, note } = detectPackageManager(env['npm_config_user_agent']);
    if (note !== undefined) output.write(`${note}\n`);
    const tarballDirectory = env['GALAXIE_CREATE_PACKAGE_DIR'];
    step = 'resolve local tarballs';
    const tarballs =
      tarballDirectory === undefined
        ? undefined
        : await resolveTarballs(tarballDirectory, request.framework as string);
    if (tarballs !== undefined)
      output.write(
        'Note: Using local tarball file: dependencies from GALAXIE_CREATE_PACKAGE_DIR.\n',
      );
    if (request.framework === 'adk-js' && tarballDirectory === undefined)
      output.write(
        'Note: Registry installation requires @galaxie-ai/adapter-adk at the generated dependency ranges. Set GALAXIE_CREATE_PACKAGE_DIR to a directory of packed galaxie tarballs.\n',
      );
    if (request.framework === 'adk-go' && tarballDirectory === undefined)
      output.write(
        'Note: Registry installation requires @galaxie-ai/adapter-go and @galaxie-ai/starter-go at the generated dependency ranges. Set GALAXIE_CREATE_PACKAGE_DIR to a directory of packed galaxie tarballs.\n',
      );
    if (request.framework === 'langgraph-python' && tarballDirectory === undefined)
      output.write(
        'Note: Registry installation requires @galaxie-ai/adapter-pyodide and @galaxie-ai/starter-python at the generated dependency ranges. Set GALAXIE_CREATE_PACKAGE_DIR to a directory of packed galaxie tarballs.\n',
      );
    step = 'load project guidance';
    const guidance = renderGuidance(
      await loadGuidanceSource(io.guidanceRoot ?? assetRoot('skills/galaxie')),
      { kind: request.kind as string, framework: request.framework as string },
    );
    step = 'compose the project';
    const result = compose(layers, {
      kind: request.kind as string,
      framework: request.framework as string,
      name,
      mode: 'project',
      packageManager,
      guidance,
      ...(tarballs === undefined ? {} : { tarballs }),
    });
    step = 'plan project writes';
    const plan = await planWrite(result.files, target, io.cwd ?? process.cwd());
    step = 'write the project';
    await writeProject(plan);
    for (const path of plan.skipped) output.write(`Kept existing ${path}.\n`);
    if (plan.skipped.length === 1) {
      const kept = plan.skipped[0]?.toLowerCase() === 'claude.md';
      output.write(
        kept
          ? 'Hint: CLAUDE.md should import AGENTS.md with @AGENTS.md.\n'
          : 'Hint: AGENTS.md was kept; point it at .agents/skills/galaxie/SKILL.md so agents find the skill.\n',
      );
    }
    output.write(
      `Created ${plan.files.size} files in ${plan.target}.\nLayers: ${result.report.layers.join(', ')}.\n`,
    );
    if (!request.noInstall) {
      step = 'install project dependencies';
      const installed = await install(packageManager, plan.target, {
        env,
        ...(io.platform === undefined ? {} : { platform: io.platform }),
        ...(io.runner === undefined ? {} : { runner: io.runner }),
      });
      if (!installed) output.write('Automatic installation is skipped on Windows.\n');
      else {
        output.write(`Next: run ${packageManager} run dev in the project directory.\n`);
        return 0;
      }
    }
    output.write(
      `Next: run ${packageManager} install --ignore-scripts, then ${packageManager} run dev in the project directory.\n`,
    );
    return 0;
  } catch (error) {
    const known =
      error instanceof UsageError ||
      error instanceof ProjectPathError ||
      error instanceof SelectionError ||
      error instanceof LayerManifestError ||
      error instanceof GuidanceError ||
      error instanceof LayerCollisionError ||
      error instanceof MergeConflictError ||
      error instanceof TarballError ||
      error instanceof ProjectWriteError ||
      error instanceof InstallError;
    errorOutput.write(`${known ? error.message : `Failed to ${step}.`}\n`);
    return error instanceof UsageError ||
      error instanceof ProjectPathError ||
      error instanceof SelectionError
      ? 2
      : 1;
  }
}
