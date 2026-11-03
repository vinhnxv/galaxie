// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Names the modules whose import loads ADK's lazy dependency chain, so a missing wheel fails at
 * boot with a fixed `unavailable` error instead of at the first run (ADR-0022 decision 4).
 */
export const adkImportProbe: string = `
import galaxie
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
import fastapi.openapi.models
import authlib.integrations.requests_client
import opentelemetry._logs
import opentelemetry.semconv
`;

/** Placeholder until the executor lands: the framework is registered but runs nothing yet. */
export const adkDriver: string = `
import json
_galaxie_ready = {'ok': False, 'code': 'unsupported'}
`;
