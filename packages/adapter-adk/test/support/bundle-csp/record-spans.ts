// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The ADK bundle takes its tracer when it is evaluated, so a host provider must already be
// registered before the first import of the bundle for ADK spans to reach it.
import { recordSpans } from './span-recorder.js';

Reflect.set(globalThis, 'adkSpanRecorder', recordSpans());
