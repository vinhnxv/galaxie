// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	_ "google.golang.org/adk/agent"
	_ "google.golang.org/adk/agent/llmagent"
	_ "google.golang.org/adk/agent/workflowagents/loopagent"
	_ "google.golang.org/adk/agent/workflowagents/parallelagent"
	_ "google.golang.org/adk/agent/workflowagents/sequentialagent"
	_ "google.golang.org/adk/model"
	_ "google.golang.org/adk/platform"
	_ "google.golang.org/adk/runner"
	_ "google.golang.org/adk/session"
	_ "google.golang.org/adk/tool"
	_ "google.golang.org/adk/tool/exitlooptool"
	_ "google.golang.org/adk/tool/functiontool"
	_ "google.golang.org/adk/tool/toolconfirmation"
	_ "google.golang.org/genai"
)
