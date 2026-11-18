// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { normalizePath, type UserConfig } from 'vite';

const main = normalizePath(fileURLToPath(new URL('./src/main.tsx', import.meta.url)));

const config: UserConfig = {
  plugins: [
    {
      name: 'galaxie-starter-zod',
      transform(code, id) {
        // Configure Zod before the app imports the renderer's schemas.
        if (id === main) return `import './zod-config.js';\n${code}`;
        return undefined;
      },
    },
  ],
};
export default config;
