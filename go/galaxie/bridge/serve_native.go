// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

//go:build !(js && wasm)

package bridge

// Serve does nothing outside js/wasm: a native program has no page to serve. Tests and reference
// programs call the handler directly.
func Serve(_ BuildInfo, _ Handler) {}
