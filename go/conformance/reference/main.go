// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// The reference module registers the conformance entries with the page. Compiled for js/wasm it is
// the program the adapter's conformance lanes load; natively it returns at once.
package main

import (
	"galaxie.invalid/galaxie/conformance/cases"
	"galaxie.invalid/galaxie/galaxie"
)

func main() {
	galaxie.ServeWith(cases.Definitions())
}
