// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentInstance,
  type CapabilityName,
  GalaxieError,
  type PendingConfirmation,
  toErrorInfo,
} from '@galaxie-ai/core';
import type { ReactElement } from 'react';
import { useAgentSnapshot } from './hooks.js';

export interface ConfirmationField {
  readonly label: string;
  readonly value: string;
}

/** Fixed host text and a host projection of the broker's actual approved arguments. */
export interface ConfirmationEntry {
  readonly title: string;
  readonly fields: (args: unknown) => readonly ConfirmationField[];
  readonly approveLabel?: string;
  readonly declineLabel?: string;
}

export interface ConfirmationRegistry {
  readonly capabilities: readonly CapabilityName[];
  entry(name: CapabilityName): ConfirmationEntry | undefined;
}

/** Separate from the agent component registry; only the host mounts confirmation prompts. */
export function defineConfirmations(
  entries: Readonly<Record<CapabilityName, ConfirmationEntry>>,
): ConfirmationRegistry {
  const registry = new Map<CapabilityName, ConfirmationEntry>();
  try {
    if (typeof entries !== 'object' || entries === null || Array.isArray(entries))
      throw new Error();
    for (const [name, entry] of Object.entries(entries)) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        Array.isArray(entry) ||
        typeof entry.title !== 'string' ||
        typeof entry.fields !== 'function' ||
        (entry.approveLabel !== undefined && typeof entry.approveLabel !== 'string') ||
        (entry.declineLabel !== undefined && typeof entry.declineLabel !== 'string')
      )
        throw new Error();
      registry.set(
        name as CapabilityName,
        Object.freeze({
          title: entry.title,
          fields: entry.fields,
          approveLabel: entry.approveLabel ?? 'Allow',
          declineLabel: entry.declineLabel ?? 'Cancel',
        }),
      );
    }
  } catch {
    throw new GalaxieError('invalid', toErrorInfo('invalid').message);
  }
  return Object.freeze({
    capabilities: Object.freeze([...registry.keys()]),
    entry: (name: CapabilityName) => registry.get(name),
  });
}

export interface ConfirmationPromptProps<Input, View> {
  readonly instance: AgentInstance<Input, View>;
  readonly confirmations: ConfirmationRegistry;
}

function display(
  confirmations: ConfirmationRegistry,
  pending: PendingConfirmation,
):
  | {
      readonly entry: ConfirmationEntry;
      readonly fields: readonly ConfirmationField[];
    }
  | undefined {
  try {
    const entry = confirmations.entry(pending.capability);
    if (entry === undefined) return undefined;
    const raw = entry.fields(pending.arguments);
    if (!Array.isArray(raw)) return undefined;
    const fields = raw.map((field: unknown) => {
      if (typeof field !== 'object' || field === null || !('label' in field) || !('value' in field))
        throw new Error();
      const { label, value } = field;
      if (typeof label !== 'string' || typeof value !== 'string') throw new Error();
      return { label, value };
    });
    return { entry, fields };
  } catch {
    return undefined;
  }
}

/** Renders host-only approvals without granting agent components a response channel. */
export function ConfirmationPrompt<Input, View>({
  instance,
  confirmations,
}: ConfirmationPromptProps<Input, View>): ReactElement {
  const snapshot = useAgentSnapshot(instance);
  return (
    <>
      {snapshot.confirmations?.map((pending) => {
        const shown = display(confirmations, pending);
        if (shown === undefined)
          return (
            <section key={pending.id}>
              <p>This action cannot be shown.</p>
              <button type="button" onClick={() => instance.respond(pending.id, 'decline')}>
                Cancel
              </button>
            </section>
          );
        return (
          <fieldset key={pending.id}>
            <legend>{shown.entry.title}</legend>
            <dl>
              {shown.fields.map((field, index) => (
                // Rows are a fixed host projection of frozen arguments, so their order is stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: no other stable identity exists.
                <div key={index}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
            <button type="button" onClick={() => instance.respond(pending.id, 'approve')}>
              {shown.entry.approveLabel ?? 'Allow'}
            </button>
            <button type="button" onClick={() => instance.respond(pending.id, 'decline')}>
              {shown.entry.declineLabel ?? 'Cancel'}
            </button>
          </fieldset>
        );
      })}
    </>
  );
}
