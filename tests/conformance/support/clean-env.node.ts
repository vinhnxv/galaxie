// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Native LangChain can register remote tracing handlers through environment variables.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('LANGCHAIN_') || key.startsWith('LANGSMITH_')) delete process.env[key];
}
