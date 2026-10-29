// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const HTTP_ORIGIN: string = 'http://127.0.0.1:63315';
export const HTTP_ERROR_BODY: string = 'http-fixture-response-body-canary';

export interface HttpFixture {
  readonly corsUrl: string;
  readonly noCorsUrl: string;
  readonly adminUrl: string;
}

export interface HttpRequestRecord {
  readonly server: 'cors' | 'no-cors';
  readonly method: string;
  readonly path: string;
  readonly origin: string | undefined;
  readonly agent: string | undefined;
  readonly run: string | undefined;
  readonly requestedMethod: string | undefined;
  readonly requestedHeaders: string | undefined;
  readonly status: number;
  readonly rejected: boolean;
}

export interface HttpAdminState {
  readonly requests: readonly HttpRequestRecord[];
}

export interface HttpControl {
  readonly fixture: HttpFixture;
  close(): Promise<void>;
}

declare module 'vitest' {
  interface ProvidedContext {
    http: HttpFixture;
  }
}
