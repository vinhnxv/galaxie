// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import * as z from 'zod';
import type { CapabilityBinding, HttpCapabilityOptions } from '../capabilities.js';
import type { ModelDescriptor } from '../models.js';
import type { BudgetLimits, DataPolicy, DestinationClass } from '../policy.js';

interface HttpConfiguration
  extends Omit<
    HttpCapabilityOptions,
    'headers' | 'fetch' | 'reconcile' | 'credentials' | 'propagateTraceContext'
  > {
  readonly headers?: string | undefined;
  readonly fetch?: string | undefined;
  readonly credentials?: RequestCredentials | undefined;
  readonly propagateTraceContext?: boolean | undefined;
}

interface EndpointConfiguration {
  readonly baseURL: string;
  readonly model: string;
  readonly maxTokens?: number | undefined;
  readonly temperature?: number | undefined;
  readonly fetch?: string | undefined;
}

interface ProviderConfiguration extends Omit<ModelDescriptor, 'languages' | 'credential'> {
  readonly languages?: readonly string[] | undefined;
  readonly credential?: boolean | undefined;
  readonly endpoint?: EndpointConfiguration | undefined;
}

interface RoleConfiguration {
  readonly providers: readonly string[];
  readonly allow: readonly DestinationClass[];
  readonly maxTokens: number;
  readonly maxCost?: number | undefined;
  readonly repairAttempts?: number | undefined;
}

interface McpToolConfiguration
  extends Pick<
    CapabilityBinding,
    'timeoutMs' | 'concurrency' | 'grantScope' | 'retry' | 'approval'
  > {
  readonly kind: 'read' | 'write';
  readonly version: number;
  readonly pin: string;
  readonly result?: 'structured' | 'text' | undefined;
}

interface McpServerConfiguration {
  readonly url: string;
  readonly destination: ModelDescriptor['destination'];
  readonly token: string;
  readonly fetch?: string | undefined;
  readonly propagateTraceContext?: boolean | undefined;
  readonly limits?:
    | {
        readonly messageBytes?: number | undefined;
        readonly resultBytes?: number | undefined;
        readonly idleMs?: number | undefined;
      }
    | undefined;
  readonly tools: Readonly<Record<string, McpToolConfiguration>>;
}

/** Parsed host wiring only; executable behavior and credentials remain in named host hooks. */
export interface HostConfigDocument {
  readonly version: '0.1';
  readonly capabilities?: Readonly<Record<string, HttpConfiguration>> | undefined;
  readonly models?:
    | {
        readonly providers: Readonly<Record<string, ProviderConfiguration>>;
        readonly roles: Readonly<Record<string, RoleConfiguration>>;
        readonly getCredential?: string | undefined;
        readonly consent?: string | undefined;
        readonly availability?: string | undefined;
        readonly download?: string | undefined;
      }
    | undefined;
  readonly mcp?: { readonly servers: Readonly<Record<string, McpServerConfiguration>> } | undefined;
  readonly limits?:
    | {
        readonly budgets?:
          | { readonly [Key in keyof BudgetLimits]?: number | undefined }
          | undefined;
        readonly dataPolicy?:
          | { readonly [Key in keyof DataPolicy]?: DataPolicy[Key] | undefined }
          | undefined;
        readonly urlAllowlist?: readonly string[] | undefined;
      }
    | undefined;
}

const destination = z.enum([
  'in-browser',
  'user-device',
  'user-endpoint',
  'host-server',
  'third-party',
]);
const allow = z.strictObject({ allow: z.array(destination) });
const policy = {
  kind: z.enum(['read', 'write', 'device', 'ui']),
  timeoutMs: z.number().positive(),
  concurrency: z.number().int().positive(),
  grantScope: z.enum(['app', 'principal', 'instance', 'run']),
  approval: z.enum(['none', 'confirm']),
  retry: z.enum(['none', 'idempotent', 'idempotency-key']),
};
const count = z.number().int().nonnegative();

export const hostConfigSchema: z.ZodType<HostConfigDocument> = z.strictObject({
  version: z.literal('0.1'),
  capabilities: z
    .record(
      z.string(),
      z.strictObject({
        ...policy,
        destination,
        url: z.string(),
        method: z.enum(['GET', 'DELETE', 'POST', 'PUT', 'PATCH']),
        headers: z.string().optional(),
        fetch: z.string().optional(),
        credentials: z.enum(['omit', 'same-origin', 'include']).optional(),
        propagateTraceContext: z.boolean().optional(),
      }),
    )
    .optional(),
  models: z
    .strictObject({
      providers: z.record(
        z.string(),
        z.strictObject({
          destination,
          modality: z.enum(['text', 'decision']),
          features: z.array(
            z.enum(['streaming', 'structured-output', 'tool-calling', 'cancellation']),
          ),
          languages: z.array(z.string()).optional(),
          pricing: z.union([
            z.literal('unknown'),
            z.strictObject({
              inputPerToken: z.number().nonnegative(),
              outputPerToken: z.number().nonnegative(),
            }),
          ]),
          credential: z.boolean().optional(),
          endpoint: z
            .strictObject({
              baseURL: z.string(),
              model: z.string().regex(/\S/),
              maxTokens: z.number().int().positive().optional(),
              temperature: z.number().optional(),
              fetch: z.string().optional(),
            })
            .optional(),
        }),
      ),
      roles: z.record(
        z.string(),
        z.strictObject({
          providers: z.array(z.string()),
          allow: z.array(destination),
          maxTokens: z.number().nonnegative(),
          maxCost: z.number().nonnegative().optional(),
          repairAttempts: count.optional(),
        }),
      ),
      getCredential: z.string().optional(),
      consent: z.string().optional(),
      availability: z.string().optional(),
      download: z.string().optional(),
    })
    .optional(),
  mcp: z
    .strictObject({
      servers: z.record(
        z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        z.strictObject({
          url: z.string(),
          destination,
          token: z.string(),
          fetch: z.string().optional(),
          propagateTraceContext: z.boolean().optional(),
          limits: z
            .strictObject({
              messageBytes: z.number().optional(),
              resultBytes: z.number().optional(),
              idleMs: z.number().optional(),
            })
            .optional(),
          tools: z.record(
            z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
            z.strictObject({
              ...policy,
              timeoutMs: z.number().int().positive(),
              kind: z.enum(['read', 'write']),
              version: z.number().int().positive(),
              pin: z.string().regex(/^[a-f0-9]{64}$/),
              result: z.enum(['structured', 'text']).optional(),
            }),
          ),
        }),
      ),
    })
    .optional(),
  limits: z
    .strictObject({
      budgets: z
        .strictObject({
          steps: z.number().int().positive().optional(),
          tokens: count.optional(),
          cost: z.number().nonnegative().optional(),
          repairAttempts: count.optional(),
          toolCalls: count.optional(),
          wallClockMs: z.number().nonnegative().optional(),
          payloadBytes: count.optional(),
          uiElements: count.optional(),
        })
        .optional(),
      dataPolicy: z
        .strictObject({
          public: allow.optional(),
          app: allow.optional(),
          'private-user': allow.optional(),
        })
        .optional(),
      urlAllowlist: z.array(z.string()).optional(),
    })
    .optional(),
});

/** Editor schema for the plain-data shape; definition, hooks and URL rules run in validation. */
export function hostConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(hostConfigSchema, { target: 'draft-2020-12' });
}
