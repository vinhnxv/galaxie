// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityBinding,
  type CapabilityContext,
  GalaxieError,
  galaxieField,
} from '@galaxie/core';
import { z } from 'zod';
import businessData from '../../fixtures/business-data.json' with { type: 'json' };
import loanDocuments from '../../fixtures/loan-documents.json' with { type: 'json' };
import marketNews from '../../fixtures/market-news.json' with { type: 'json' };

export const RESULT_BYTES = 4096;
export const RESULT_ITEMS = 5;
const INVALID = 'The capability arguments are invalid.';
const privateField = galaxieField({ label: 'private-user' });
const publicField = galaxieField({ label: 'public' });
const applicationId = z
  .string()
  .max(52)
  .regex(/^application-[a-z0-9-]{1,40}$/)
  .meta(galaxieField({ label: 'private-user', shape: 'id' }));
const applicationInput = z.strictObject({ applicationId });
const decision = z
  .enum(['approved', 'denied'])
  .meta(galaxieField({ label: 'private-user', shape: 'enum' }));
const priceInput = z.strictObject({
  creditScore: z.number().int().min(300).max(850),
  amount: z.number().int().min(1000).max(250000),
  termMonths: z.number().int().min(12).max(60),
});
const priceOutput = z
  .strictObject({
    tier: z.enum(['preferred', 'standard', 'review']),
    annualRatePercent: z.number(),
  })
  .meta(privateField);
const finalizeInput = z.strictObject({ applicationId, decision });
const finalizeOutput = z
  .strictObject({
    applicationId,
    decision,
    finalized: z.literal(true),
  })
  .meta(privateField);
const marketItem = z
  .strictObject({
    id: z.string(),
    company: z.string(),
    title: z.string(),
    summary: z.string(),
  })
  .meta(publicField);
const documentItem = z.strictObject({ title: z.string(), text: z.string() }).meta(privateField);
const businessItem = z
  .strictObject({
    company: z.string(),
    applicant: z.string(),
    annualRevenue: z.number(),
    creditScore: z.number().int(),
  })
  .meta(privateField);

function collection<S extends z.ZodType>(item: S) {
  return z.strictObject({
    status: z.enum(['ok', 'not_found']),
    items: z.array(item).max(RESULT_ITEMS),
    truncated: z.boolean(),
    marker: z.enum(['', '[truncated]']),
  });
}

interface Collection<T> {
  status: 'ok' | 'not_found';
  items: T[];
  truncated: boolean;
  marker: '' | '[truncated]';
}
interface ApplicationInput {
  applicationId: string;
}
interface PriceInput {
  creditScore: number;
  amount: number;
  termMonths: number;
}
interface PriceResult {
  tier: 'preferred' | 'standard' | 'review';
  annualRatePercent: number;
}
export interface DecisionRecord extends ApplicationInput {
  decision: 'approved' | 'denied';
  finalized: true;
}
interface Request<I, O, Kind extends 'read' | 'write' = 'read'> {
  readonly kind: Kind;
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
}

export const capabilityRequests: {
  readonly 'market.search@1': Request<
    { query: string },
    Collection<{
      id: string;
      company: string;
      title: string;
      summary: string;
    }> & { trust: 'untrusted-tool-output' }
  >;
  readonly 'loan.documents@1': Request<
    ApplicationInput,
    Collection<{ title: string; text: string }>
  >;
  readonly 'loan.business@1': Request<
    ApplicationInput,
    Collection<{
      company: string;
      applicant: string;
      annualRevenue: number;
      creditScore: number;
    }>
  >;
  readonly 'loan.price@1': Request<PriceInput, PriceResult>;
  readonly 'loan.finalize@1': Request<
    ApplicationInput & { decision: 'approved' | 'denied' },
    DecisionRecord,
    'write'
  >;
} = {
  'market.search@1': {
    kind: 'read',
    input: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .meta(galaxieField({ shape: 'freeText' })),
    }),
    output: collection(marketItem).extend({ trust: z.literal('untrusted-tool-output') }),
  },
  'loan.documents@1': { kind: 'read', input: applicationInput, output: collection(documentItem) },
  'loan.business@1': { kind: 'read', input: applicationInput, output: collection(businessItem) },
  'loan.price@1': { kind: 'read', input: priceInput, output: priceOutput },
  'loan.finalize@1': { kind: 'write', input: finalizeInput, output: finalizeOutput },
};

type Requests = typeof capabilityRequests;
export type RecipeBindings = {
  readonly [K in keyof Requests]: CapabilityBinding<
    z.infer<Requests[K]['input']>,
    z.infer<Requests[K]['output']>
  >;
};

/** Cap the complete JSON envelope in UTF-8 bytes, including the visible truncation marker. */
function bounded<T, Extra extends object>(
  items: readonly T[],
  extra: Extra,
  found = true,
): Collection<T> & Extra {
  const result = {
    ...extra,
    status: found ? ('ok' as const) : ('not_found' as const),
    items: items.slice(0, RESULT_ITEMS),
    truncated: items.length > RESULT_ITEMS,
    marker: '' as '' | '[truncated]',
  };
  result.marker = result.truncated ? '[truncated]' : '';
  while (new TextEncoder().encode(JSON.stringify(result)).length > RESULT_BYTES) {
    result.items.pop();
    result.truncated = true;
    result.marker = '[truncated]';
  }
  return result;
}

const bindingPolicy = {
  destination: 'in-browser',
  timeoutMs: 1000,
  concurrency: 1,
  grantScope: 'instance',
  approval: 'none',
  retry: 'none',
} as const;

export function createHostCapabilities(principal: string): {
  readonly bindings: RecipeBindings;
  decisions(): readonly DecisionRecord[];
} {
  if (principal === '') throw new GalaxieError('invalid', INVALID);
  const records = new Map<string, DecisionRecord>();
  function bind<I extends z.ZodType, O extends z.ZodType>(
    request: { readonly input: I; readonly output: O; readonly kind: 'read' | 'write' },
    invoke: (input: z.infer<I>, context: CapabilityContext) => z.infer<O>,
  ): CapabilityBinding<z.infer<I>, z.infer<O>> {
    return {
      ...bindingPolicy,
      kind: request.kind,
      approval: request.kind === 'write' ? 'confirm' : 'none',
      async invoke(input, context) {
        if (context.principalScope !== principal)
          throw new GalaxieError('denied', 'The application is not allowed.');
        if (context.signal.aborted) throw new GalaxieError('cancelled', 'The call was cancelled.');
        const parsed = request.input.safeParse(input);
        if (!parsed.success) throw new GalaxieError('invalid', INVALID);
        const output = request.output.safeParse(invoke(parsed.data, context));
        if (!output.success)
          throw new GalaxieError('unavailable', 'The fixture result is invalid.');
        return output.data;
      },
    };
  }
  return {
    bindings: {
      'market.search@1': bind(capabilityRequests['market.search@1'], ({ query }) => {
        const needle = query.toLowerCase();
        const items = marketNews.filter((item) =>
          `${item.company} ${item.title} ${item.summary}`.toLowerCase().includes(needle),
        );
        return bounded(items, { trust: 'untrusted-tool-output' as const });
      }),
      'loan.documents@1': bind(capabilityRequests['loan.documents@1'], ({ applicationId }) => {
        const application = loanDocuments.find((item) => item.applicationId === applicationId);
        return bounded(application?.documents ?? [], {}, !!application);
      }),
      'loan.business@1': bind(capabilityRequests['loan.business@1'], ({ applicationId }) => {
        const application = businessData.find((item) => item.applicationId === applicationId);
        const items =
          application === undefined
            ? []
            : [
                {
                  company: application.company,
                  applicant: application.applicant,
                  annualRevenue: application.annualRevenue,
                  creditScore: application.creditScore,
                },
              ];
        return bounded(items, {}, !!application);
      }),
      'loan.price@1': bind(capabilityRequests['loan.price@1'], ({ creditScore }): PriceResult => {
        // Synthetic demonstration tiers, not an upstream pricing port or a lending policy.
        if (creditScore >= 750) return { tier: 'preferred', annualRatePercent: 6.5 };
        if (creditScore >= 650) return { tier: 'standard', annualRatePercent: 9.5 };
        return { tier: 'review', annualRatePercent: 12.5 };
      }),
      'loan.finalize@1': bind(capabilityRequests['loan.finalize@1'], (input) => {
        if (!loanDocuments.some((item) => item.applicationId === input.applicationId))
          throw new GalaxieError('invalid', 'The application was not found.');
        if (records.has(input.applicationId))
          throw new GalaxieError('denied', 'The application was already finalized.');
        const record: DecisionRecord = { ...input, finalized: true };
        records.set(input.applicationId, Object.freeze(record));
        return record;
      }),
    },
    decisions: () =>
      Object.freeze([...records.values()].map((record) => Object.freeze({ ...record }))),
  };
}
