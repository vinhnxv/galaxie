// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { CASE_NAMES, type CaseName, cases } from './cases/index.js';
import branching from './golden/branching.json' with { type: 'json' };
import capability from './golden/capability.json' with { type: 'json' };
import interruptDurabilityExit from './golden/interrupt-durability-exit.json' with { type: 'json' };
import interruptDurabilitySync from './golden/interrupt-durability-sync.json' with { type: 'json' };
import interruptResume from './golden/interrupt-resume.json' with { type: 'json' };
import interruptSequence from './golden/interrupt-sequence.json' with { type: 'json' };
import interruptSubgraph from './golden/interrupt-subgraph.json' with { type: 'json' };
import linear from './golden/linear.json' with { type: 'json' };
import modelFailure from './golden/model-failure.json' with { type: 'json' };
import modelWithoutConfig from './golden/model-without-config.json' with { type: 'json' };
import stepLimit from './golden/step-limit.json' with { type: 'json' };
import subgraph from './golden/subgraph.json' with { type: 'json' };
import { diff } from './support/diff.js';
import { compatibilityMatrix } from './support/matrix.js';
import { normalize } from './support/normalize.js';
import { galaxieLane, runGalaxie } from './support/transcript.js';

const goldens: Record<CaseName, unknown> = {
  'interrupt-durability-exit': interruptDurabilityExit,
  'interrupt-durability-sync': interruptDurabilitySync,
  'interrupt-subgraph': interruptSubgraph,
  'interrupt-sequence': interruptSequence,
  'interrupt-resume': interruptResume,
  linear,
  capability,
  'step-limit': stepLimit,
  branching,
  subgraph,
  'model-without-config': modelWithoutConfig,
  'model-failure': modelFailure,
};

test.each(CASE_NAMES)('%s differences exactly match the compatibility matrix', async (name) => {
  const transcript = await runGalaxie(cases[name]);
  expect(transcript.outcome).toEqual(
    name === 'model-failure'
      ? { status: 'failed', errorType: 'FixtureModelError' }
      : name === 'step-limit'
        ? { status: 'failed', errorType: 'GraphRecursionError' }
        : { status: 'succeeded' },
  );
  const differences = diff(goldens[name], normalize(transcript)).sort();
  const listed = compatibilityMatrix.find(
    (entry) => entry.case === name && entry.lane === galaxieLane(),
  );
  expect(differences).toEqual(listed?.differences.toSorted() ?? []);
});
