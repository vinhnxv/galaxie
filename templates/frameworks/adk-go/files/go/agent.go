// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"galaxie.invalid/galaxie/galaxie"
	"google.golang.org/adk/agent"
	"google.golang.org/adk/agent/llmagent"
	"google.golang.org/adk/model"
	"google.golang.org/adk/tool"
	"google.golang.org/genai"
)

func build() (agent.Agent, error) {
	question, err := galaxie.CapabilityTool("question.ask@1", galaxie.ToolSpec{
		Description: "Ask the practice question.", LongRunning: true,
		Schema: `{"type":"object","properties":{"message":{"type":"string"}},"required":["message"],"additionalProperties":false}`,
	})
	if err != nil {
		return nil, err
	}
	return galaxie.LlmAgent(llmagent.Config{
		Name: "starter", Model: galaxie.Model("comment"), Tools: []tool.Tool{question},
		BeforeModelCallbacks: []llmagent.BeforeModelCallback{func(ctx agent.CallbackContext, request *model.LLMRequest) (*model.LLMResponse, error) {
			asked, _ := ctx.State().Get("starter_asked")
			if asked == true {
				// Keep the closing request text-only for the host's model providers.
				request.Contents = []*genai.Content{{Role: "user", Parts: []*genai.Part{{Text: "Give one short encouraging sentence about practicing."}}}}
				request.Tools = map[string]any{}
				if request.Config != nil {
					request.Config.Tools = nil
				}
				return nil, nil
			}
			if err := ctx.State().Set("starter_asked", true); err != nil {
				return nil, err
			}
			return &model.LLMResponse{Content: &genai.Content{Role: "model", Parts: []*genai.Part{{FunctionCall: &genai.FunctionCall{ID: "starter-question", Name: "question_ask_1", Args: map[string]any{"message": "What is 2 + 2?"}}}}}}, nil
		}},
	})
}

func interaction(_ []galaxie.Request) (map[string]any, error) {
	return map[string]any{
		"surfaceId": "question", "component": "education.Quiz/v1", "viewRevision": "question-v1",
		"props": map[string]any{"title": "A tiny local agent", "questions": []any{map[string]any{
			"id": "sum", "prompt": "What is 2 + 2?", "options": []any{map[string]any{"id": "four", "label": "4"}, map[string]any{"id": "five", "label": "5"}},
		}}},
	}, nil
}

func resume(requests []galaxie.Request, action string, payload any) ([]galaxie.Decision, error) {
	object, ok := payload.(map[string]any)
	if !ok || action != "submit" || len(object) != 1 {
		return nil, errors.New("The quiz answer must be valid.")
	}
	answers, ok := object["answers"].(map[string]any)
	if !ok || len(answers) != 1 || (answers["sum"] != "four" && answers["sum"] != "five") {
		return nil, errors.New("The quiz answer must be valid.")
	}
	grade := "The answer is 4."
	if answers["sum"] == "four" {
		grade = "Correct."
	}
	decisions := make([]galaxie.Decision, len(requests))
	for index := range requests {
		decisions[index] = galaxie.Respond(map[string]any{"grade": grade})
	}
	return decisions, nil
}
