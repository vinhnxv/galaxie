// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Native LangChain can register remote tracing handlers through environment variables.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('LANGCHAIN_') || key.startsWith('LANGSMITH_')) delete process.env[key];
}
