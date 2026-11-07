// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0
// A2UI project examples, Apache-2.0, specification v1.0.
// Source: https://github.com/a2ui-project/a2ui/blob/dee8167996b0a802b18b3ebe51f3515c55b757de/specification/v1_0/docs/a2ui_protocol.md
// Upstream commit: dee8167996b0a802b18b3ebe51f3515c55b757de

export const upstreamVectors: readonly unknown[] = [
  {
    version: '1.0',
    createSurface: {
      surfaceId: 'user_profile_card',
      catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
      sendDataModel: true,
      components: [
        { id: 'root', component: 'Column', children: ['user_name'] },
        {
          id: 'user_name',
          component: 'Text',
          text: { '@path': '/name' },
        },
      ],
      dataModel: { name: 'John Doe' },
    },
  },
  {
    version: '1.0',
    updateComponents: {
      surfaceId: 'user_profile_card',
      components: [
        { id: 'root', component: 'Column', children: ['user_name', 'user_title'] },
        { id: 'user_name', component: 'Text', text: 'John Doe' },
        { id: 'user_title', component: 'Text', text: 'Software Engineer' },
      ],
    },
  },
  {
    version: '1.0',
    updateDataModel: {
      surfaceId: 'user_profile_card',
      path: '/user/name',
      value: 'Jane Doe',
    },
  },
  { version: '1.0', deleteSurface: { surfaceId: 'user_profile_card' } },
];
