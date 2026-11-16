// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

'use client';

import dynamic from 'next/dynamic';
import type { ReactElement } from 'react';
import { z } from 'zod';

z.config({ jitless: true });

const LangGraph = dynamic(() => import('./langgraph-host.js'), { ssr: false });
const Adk = dynamic(() => import('./adk-host.js'), { ssr: false });

export function ClientAgent({
  framework,
}: {
  readonly framework: 'langgraph' | 'adk';
}): ReactElement {
  return framework === 'langgraph' ? <LangGraph /> : <Adk />;
}
