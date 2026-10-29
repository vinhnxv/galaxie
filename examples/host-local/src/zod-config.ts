// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from 'zod';

// Avoid Zod's new Function probe under the strict CSP and Trusted Types.
config({ jitless: true });
