// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { UserConfig } from 'vite';

const config: UserConfig = {
  define: { 'process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS': '"false"' },
};
export default config;
