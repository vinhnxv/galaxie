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

/**
 * The ADK Python run loop. It builds the executor from the agent's entry factory and runs one
 * conversation per call, streaming checked text deltas and content-free step markers; the model,
 * the tools and the budget all go through the bridge. A pause (a confirmation or a long-running
 * tool) ends the run with the interaction pending in the executor, and the answer resumes it as a
 * new run. Durable sessions stay off until their stage ships (ADR-0022).
 */
export const adkDriver: string = `
import sys, json, asyncio, importlib
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream_data
from _galaxie_transport import request as _transport, notify as _notify
from galaxie.adk import prepare_executor, quiet
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
try:
    with quiet():
        _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)())
    _galaxie_ready = {'ok': True}
except GalaxieError as error:
    _galaxie_ready = {'ok': False, 'code': error.code}
except Exception:
    _galaxie_ready = {'ok': False, 'code': 'unavailable'}
async def _galaxie_pending():
    try:
        pending = _galaxie_executor.pending(_galaxie_thread)
        return json.dumps({'ok': True, 'interrupts': [pending] if pending else []})
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        payload = json.loads(_galaxie_input)
        output = await _galaxie_executor.run(
            payload.get('input'), payload['threadId'], payload['steps'],
            on_stream=lambda mode, data: notify_stream_data([], mode, data),
            resume=payload.get('resume'),
        )
        if _galaxie_executor.pending(payload['threadId']) is not None:
            return json.dumps({'ok': True, 'interrupted': True})
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`;
