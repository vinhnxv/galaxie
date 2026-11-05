// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './adk-env.js';
import { goBuild } from 'virtual:adk-recipes-go';
import { pythonBuild } from 'virtual:adk-recipes-python';
import { LEGAL_DISCLAIMER } from './disclaimer.js';
import { hostModels } from './runtime.js';

const providers = document.getElementById('providers');
const assets = document.getElementById('assets');
const disclaimer = document.getElementById('disclaimer');
if (providers && assets && disclaimer) {
  const names = Object.keys(hostModels(import.meta.env.MODE).providers);
  providers.textContent =
    names.length > 0
      ? 'Model available: deterministic mock (in browser). No download is needed.'
      : 'No model provider is configured. Use mock mode to inspect the scaffold.';
  assets.textContent = `Python recipe assets: ${pythonBuild.available ? 'available' : 'unavailable'}. Go recipe assets: ${goBuild.available ? 'available' : 'unavailable'}.`;
  disclaimer.textContent = LEGAL_DISCLAIMER;
}
