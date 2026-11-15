#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { run } from './main.js';

process.exitCode = await run(process.argv.slice(2));
