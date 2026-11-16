// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy } from './src/policy.js';

export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const development = process.env.NODE_ENV === 'development';
  const header = development ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
  const policy = contentSecurityPolicy(nonce, development);
  const headers = new Headers(request.headers);
  headers.set('x-nonce', nonce);
  headers.set(header, policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set(header, policy);
  return response;
}

// Static worker chunks need their own response policy, so /_next/static is included.
export const config = { matcher: ['/((?!_next/image|favicon.ico).*)'] };
