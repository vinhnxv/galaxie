// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}
function binary(value: unknown): boolean {
  if (
    !object(value) ||
    !keys(value, ['type', 'bytes']) ||
    !text(value['type']) ||
    typeof value['bytes'] !== 'string'
  )
    return false;
  try {
    return btoa(atob(value['bytes'])) === value['bytes'];
  } catch {
    return false;
  }
}
export function validCheckpointRequest(value: unknown): boolean {
  if (!object(value) || !text(value['sessionId'])) return false;
  const location = ['op', 'sessionId', 'namespace'];
  if (value['op'] === 'delete') return keys(value, ['op', 'sessionId']);
  if (value['op'] === 'list')
    return (
      keys(value, ['op', 'sessionId'], ['namespace', 'id', 'before', 'limit']) &&
      (value['namespace'] === undefined || typeof value['namespace'] === 'string') &&
      (value['id'] === undefined || text(value['id'])) &&
      (value['before'] === undefined || text(value['before'])) &&
      (value['limit'] === undefined || (integer(value['limit']) && value['limit'] >= 0))
    );
  if (typeof value['namespace'] !== 'string') return false;
  if (value['op'] === 'get')
    return keys(value, location, ['id']) && (value['id'] === undefined || text(value['id']));
  if (!text(value['id'])) return false;
  if (value['op'] === 'put')
    return (
      keys(value, [...location, 'id', 'parentId', 'checkpoint', 'metadata', 'timestamp']) &&
      (value['parentId'] === null || text(value['parentId'])) &&
      binary(value['checkpoint']) &&
      binary(value['metadata']) &&
      text(value['timestamp'])
    );
  return (
    value['op'] === 'put-writes' &&
    keys(value, [...location, 'id', 'taskId', 'taskPath', 'writes']) &&
    text(value['taskId']) &&
    typeof value['taskPath'] === 'string' &&
    Array.isArray(value['writes']) &&
    value['writes'].every(
      (write: unknown) =>
        object(write) &&
        keys(write, ['channel', 'index', 'value', 'interruptIds']) &&
        typeof write['channel'] === 'string' &&
        integer(write['index']) &&
        binary(write['value']) &&
        Array.isArray(write['interruptIds']) &&
        write['interruptIds'].every(text) &&
        (write['channel'] === '__interrupt__' || write['interruptIds'].length === 0),
    )
  );
}
function tuple(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, [
      'sessionId',
      'namespace',
      'id',
      'parentId',
      'checkpoint',
      'metadata',
      'writes',
      'parentWrites',
    ]) &&
    text(value['sessionId']) &&
    typeof value['namespace'] === 'string' &&
    text(value['id']) &&
    (value['parentId'] === null || text(value['parentId'])) &&
    binary(value['checkpoint']) &&
    binary(value['metadata']) &&
    ['writes', 'parentWrites'].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every(
          (write: unknown) =>
            object(write) &&
            keys(write, ['taskId', 'channel', 'value', 'taskPath', 'index']) &&
            text(write['taskId']) &&
            typeof write['channel'] === 'string' &&
            binary(write['value']) &&
            typeof write['taskPath'] === 'string' &&
            integer(write['index']),
        ),
    )
  );
}
export function validCheckpointReply(value: unknown): boolean {
  return value === null || tuple(value) || (Array.isArray(value) && value.every(tuple));
}

/** Only checkpoint envelopes contain byte arrays; all other fields are plain JSON. */
export function checkpointBytes(value: unknown, direction: 'encode' | 'decode'): unknown {
  if (Array.isArray(value)) return value.map((item) => checkpointBytes(item, direction));
  if (!object(value)) return value;
  if (keys(value, ['type', 'bytes'])) {
    if (direction === 'decode')
      return {
        type: value['type'],
        bytes: Uint8Array.from(atob(value['bytes'] as string), (char) => char.charCodeAt(0)),
      };
    let binary = '';
    for (const byte of value['bytes'] as Uint8Array) binary += String.fromCharCode(byte);
    return { type: value['type'], bytes: btoa(binary) };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, checkpointBytes(item, direction)]),
  );
}

/** Register stored input and replayed values before returning a journal to the Worker. */
export function dspyCheckpointValues(value: unknown): unknown {
  if (!object(value) || !object(value['checkpoint'])) return undefined;
  const checkpoint = value['checkpoint'];
  if (checkpoint['type'] !== 'dspy.journal/v1') return undefined;
  const record: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(checkpoint['bytes'] as Uint8Array),
  );
  // Only a paused journal is replayed; compact completion markers carry no data.
  if (!object(record) || record['status'] !== 'paused' || !Array.isArray(record['journal']))
    return undefined;
  return [
    record['input'],
    ...record['journal'].map((entry: unknown) => (object(entry) ? entry['result'] : undefined)),
  ];
}

/**
 * Register the text-bearing values of a stored ADK conversation before returning it to the Worker:
 * event text, error messages, state values, call arguments and responses, and the pending request.
 * The integrity key and counters are never registered.
 */
export function adkCheckpointValues(value: unknown): unknown {
  if (!object(value) || !object(value['checkpoint']) || !object(value['metadata']))
    return undefined;
  const checkpoint = value['checkpoint'];
  if (checkpoint['type'] !== 'adk-python.session/v1') return undefined;
  const decode = (bytes: unknown): unknown =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes as Uint8Array));
  const record = decode(checkpoint['bytes']);
  const metadata = decode(value['metadata']['bytes']);
  if (!object(record) || !Array.isArray(record['events']) || !object(metadata))
    throw new Error('invalid');
  const values: unknown[] = [];
  for (const event of record['events']) {
    if (!object(event)) throw new Error('invalid');
    values.push(event['errorMessage']);
    const actions = event['actions'];
    if (object(actions) && object(actions['stateDelta']))
      values.push(...Object.values(actions['stateDelta']));
    const content = event['content'];
    for (const part of object(content) && Array.isArray(content['parts']) ? content['parts'] : []) {
      if (!object(part)) throw new Error('invalid');
      values.push(part['text']);
      if (object(part['functionCall'])) values.push(part['functionCall']['args']);
      if (object(part['functionResponse'])) values.push(part['functionResponse']['response']);
    }
  }
  values.push(metadata['pending']);
  return values;
}
