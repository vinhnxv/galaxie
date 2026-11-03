// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The Worker entry of the Transformers.js ONNX chat provider (ADR-0021). Stage O1 ships the
// package entry only; `startTransformersWorker` arrives with the engine in a later stage.
// Importing this module starts nothing and loads no model library.
export {};
