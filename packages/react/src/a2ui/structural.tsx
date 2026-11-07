// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ReactElement } from 'react';
import { z } from 'zod';
import { type ComponentEntry, type ComponentProps, defineComponent } from '../registry.js';
import { catalogComponentId } from './catalog.js';

const childList = z.union([
  z.array(z.string().min(1)),
  z.strictObject({ componentId: z.string().min(1), path: z.string() }),
]);
const groupSchema = z.strictObject({ children: childList });
const textSchema = z.strictObject({
  text: z.union([z.string(), z.strictObject({ '@path': z.string() })]),
});

export type ChildList = string[] | { componentId: string; path: string };
export interface GroupProps {
  children: ChildList;
}
export interface TextProps {
  text: string | { '@path': string };
}

function Group({ children }: ComponentProps<GroupProps, Record<string, never>>): ReactElement {
  return <div>{children}</div>;
}

function Text({ props }: ComponentProps<TextProps, Record<string, never>>): ReactElement {
  return <span>{typeof props.text === 'string' ? props.text : null}</span>;
}

/** Headless composition entries; the host supplies layout and presentation. */
export function structuralComponents(
  catalogId: string,
): readonly [
  ComponentEntry<GroupProps, Record<string, never>>,
  ComponentEntry<GroupProps, Record<string, never>>,
  ComponentEntry<TextProps, Record<string, never>>,
  ComponentEntry<GroupProps, Record<string, never>>,
] {
  const group = (name: string): ComponentEntry<GroupProps, Record<string, never>> =>
    defineComponent({
      id: catalogComponentId(catalogId, name),
      props: groupSchema,
      actions: {},
      children: ['children'],
      component: Group,
    });
  return [
    group('Column'),
    group('Row'),
    defineComponent({
      id: catalogComponentId(catalogId, 'Text'),
      props: textSchema,
      actions: {},
      bindable: ['text'],
      component: Text,
    }),
    group('Card'),
  ];
}
