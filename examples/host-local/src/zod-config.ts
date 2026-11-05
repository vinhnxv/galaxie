// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { config } from 'zod';

// Avoid Zod's new Function probe under the strict CSP and Trusted Types.
config({ jitless: true });
