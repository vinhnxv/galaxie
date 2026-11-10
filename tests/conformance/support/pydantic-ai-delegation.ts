// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type PydanticTranscript, RecordingModel } from './pydantic-ai.js';

export function delegationModel(): { model: RecordingModel; transcript: PydanticTranscript } {
  const transcript: PydanticTranscript = {
    requests: [],
    responses: [],
    capabilities: [],
    interactions: [],
    output: null,
    error: null,
  };
  return { model: new RecordingModel({ smoke: [{ text: 'done' }] }, transcript), transcript };
}
