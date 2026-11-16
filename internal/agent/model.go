package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// The model is reached over the OpenAI-compatible chat completions protocol,
// which OpenRouter, OpenAI, Anthropic, Gemini, LM Studio and Ollama all serve.
// ChatMessage is that protocol's message and also the unit of a saved transcript.
type ChatMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	// ReasoningDetails is OpenRouter's opaque reasoning state. Providers that
	// emit it expect it back unchanged on the next request; others never see it.
	ReasoningDetails json.RawMessage `json:"reasoning_details,omitempty"`
}

// MarshalJSON sends an assistant message that only calls tools with null
// content, the shape providers emit and the one all of them accept back.
func (m ChatMessage) MarshalJSON() ([]byte, error) {
	type plain ChatMessage
	if m.Role == "assistant" && m.Content == "" && len(m.ToolCalls) > 0 {
		return json.Marshal(struct {
			plain
			Content *string `json:"content"`
		}{plain: plain(m)})
	}
	return json.Marshal(plain(m))
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Completion struct {
	Message      ChatMessage
	FinishReason string
	InputTokens  int64
	OutputTokens int64
}

type Model struct {
	BaseURL string // e.g. https://openrouter.ai/api/v1
	APIKey  string // empty for local servers
	Name    string
	HTTP    *http.Client
	// RetryWait is the base delay before a quick retry; it grows with each attempt.
	RetryWait time.Duration
	// Params are extra request fields sent as given, for what differs between
	// vendors: reasoning effort, token limits, provider routing.
	Params map[string]json.RawMessage
}

// modelError is a non-2xx answer from the model endpoint.
type modelError struct {
	status int
	body   string
}

func (e *modelError) Error() string {
	return fmt.Sprintf("model endpoint returned %d: %s", e.status, e.body)
}

func (e *modelError) transient() bool {
	return e.status == http.StatusTooManyRequests || e.status == http.StatusRequestTimeout || e.status >= 500
}

// Complete asks for the next assistant message. Transient failures get two
// quick retries here; anything longer is the inbox's retry, which replays the run.
func (m *Model) Complete(ctx context.Context, messages []ChatMessage, tools []json.RawMessage) (*Completion, error) {
	request := map[string]any{}
	for name, value := range m.Params {
		request[name] = value
	}
	request["model"], request["messages"], request["tools"] = m.Name, messages, tools
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(attempt*attempt) * m.RetryWait):
			}
		}
		c, err := m.complete(ctx, body)
		if err == nil {
			return c, nil
		}
		lastErr = err
		if me, ok := err.(*modelError); ok && !me.transient() {
			break
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, lastErr
}

func (m *Model) complete(ctx context.Context, body []byte) (*Completion, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(m.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if m.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+m.APIKey)
	}
	resp, err := m.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, &modelError{status: resp.StatusCode, body: clip(string(raw), 2000)}
	}
	var out struct {
		Choices []struct {
			Message      ChatMessage `json:"message"`
			FinishReason string      `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int64 `json:"prompt_tokens"`
			CompletionTokens int64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode model response: %w: %s", err, clip(string(raw), 500))
	}
	if len(out.Choices) == 0 {
		return nil, fmt.Errorf("model response has no choices: %s", clip(string(raw), 500))
	}
	msg := out.Choices[0].Message
	msg.Role = "assistant"
	for i := range msg.ToolCalls {
		msg.ToolCalls[i].Type = "function"
	}
	return &Completion{
		Message:      msg,
		FinishReason: out.Choices[0].FinishReason,
		InputTokens:  out.Usage.PromptTokens,
		OutputTokens: out.Usage.CompletionTokens,
	}, nil
}

// clip shortens s to at most n bytes and says so when it does.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return fmt.Sprintf("%s\n[truncated: first %d of %d bytes shown]", strings.ToValidUTF8(s[:n], ""), n, len(s))
}
