// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// A hand-encoded ONNX model holding one `Identity` node over a float vector, so the probe needs
// no binary fixture. Field numbers follow onnx.proto3 (ModelProto, GraphProto, NodeProto,
// ValueInfoProto, TypeProto.Tensor, TensorShapeProto).

const encoder = new TextEncoder();

function varint(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return bytes;
}

const field = (number: number, wire: number, payload: readonly number[]): number[] => [
  ...varint(number * 8 + wire),
  ...payload,
];
const intField = (number: number, value: number): number[] => field(number, 0, varint(value));
const bytesField = (number: number, payload: readonly number[]): number[] =>
  field(number, 2, [...varint(payload.length), ...payload]);
const textField = (number: number, value: string): number[] =>
  bytesField(number, [...encoder.encode(value)]);

function vector(name: string, length: number): number[] {
  const dimension = bytesField(1, intField(1, length));
  const shape = bytesField(2, dimension);
  const tensor = bytesField(1, [...intField(1, 1), ...shape]);
  return [...textField(1, name), ...bytesField(2, tensor)];
}

/** An ONNX model computing `output = Identity(input)` over `length` floats. */
export function identityModel(length: number): Uint8Array {
  const node = [
    ...textField(1, 'input'),
    ...textField(2, 'output'),
    ...textField(3, 'identity'),
    ...textField(4, 'Identity'),
  ];
  const graph = [
    ...bytesField(1, node),
    ...textField(2, 'identity-graph'),
    ...bytesField(11, vector('input', length)),
    ...bytesField(12, vector('output', length)),
  ];
  const opset = intField(2, 13);
  return Uint8Array.from([...intField(1, 8), ...bytesField(8, opset), ...bytesField(7, graph)]);
}
