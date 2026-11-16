// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package main

import "galaxie.invalid/galaxie/galaxie"

func main() {
	galaxie.ServeWith(map[string]galaxie.Definition{
		"starter": {Build: build, Interaction: interaction, Resume: resume},
	})
}
