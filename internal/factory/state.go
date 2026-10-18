package factory

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

type WorkflowRecord struct {
	ID         string    `json:"id"`
	Revision   string    `json:"revision"`
	YAML       string    `json:"yaml"`
	Definition Workflow  `json:"definition"`
	UpdatedAt  time.Time `json:"updated_at"`
}
type Usage struct {
	PromptTokens     int      `json:"prompt_tokens"`
	CompletionTokens int      `json:"completion_tokens"`
	TotalTokens      int      `json:"total_tokens"`
	Cost             *float64 `json:"cost,omitempty"`
}
type Result struct {
	Candidate *Candidate `json:"candidate,omitempty"`
	Sandbox   string     `json:"sandbox,omitempty"`
	Artifact  string     `json:"artifact,omitempty"`
	Harness   string     `json:"harness,omitempty"`
	Turns     int        `json:"turns,omitempty"`
	ToolCalls int        `json:"tool_calls,omitempty"`
	Provider  string     `json:"provider,omitempty"`
	Model     string     `json:"model,omitempty"`
	RequestID string     `json:"request_id,omitempty"`
	Usage     *Usage     `json:"usage,omitempty"`

	Outcome   string `json:"outcome"`
	Output    string `json:"output"`
	Error     string `json:"error,omitempty"`
	ExitCode  int    `json:"exit_code"`
	Truncated bool   `json:"truncated,omitempty"`
}
type Attempt struct {
	Finalized     bool       `json:"finalized"`
	CheckpointSHA string     `json:"checkpoint_sha,omitempty"`
	Transcript    string     `json:"transcript,omitempty"`
	ID            string     `json:"id"`
	Node          string     `json:"node"`
	StartedAt     time.Time  `json:"started_at"`
	FinishedAt    *time.Time `json:"finished_at,omitempty"`
	Result        Result     `json:"result"`
}
type Question struct {
	CandidateID string    `json:"candidate_id,omitempty"`
	ID          string    `json:"id"`
	Node        string    `json:"node"`
	Prompt      string    `json:"prompt"`
	Choices     []string  `json:"choices"`
	CreatedAt   time.Time `json:"created_at"`
}
type Decision struct {
	CandidateID string `json:"candidate_id,omitempty"`
	QuestionID  string `json:"question_id"`
	Choice      string `json:"choice"`
	Comment     string `json:"comment,omitempty" maxLength:"8192"`
}

// SandboxState identifies the remote machine a run executes on. Home is the
// sandbox user's home directory, the root of every path KILN uses there.
type SandboxState struct {
	Provider string `json:"provider"`
	ID       string `json:"id"`
	Type     string `json:"type"`
	Home     string `json:"home,omitempty"`
	URL      string `json:"url,omitempty"`
}
type Run struct {
	Candidate    *Candidate        `json:"candidate,omitempty"`
	Sandbox      *SandboxState     `json:"sandbox,omitempty"`
	Artifacts    string            `json:"artifacts,omitempty"`
	ID           string            `json:"id"`
	Workflow     Workflow          `json:"workflow"`
	Revision     string            `json:"revision"`
	AutomationID string            `json:"automation_id,omitempty"`
	Status       string            `json:"status" enum:"queued,running,waiting,succeeded,failed,canceled,interrupted"`
	Current      string            `json:"current"`
	Inputs       map[string]string `json:"inputs"`
	Outputs      map[string]Result `json:"outputs"`
	Visits       map[string]int    `json:"visits"`
	Attempts     []Attempt         `json:"attempts"`
	Steps        int               `json:"steps"`
	Workspace    string            `json:"workspace,omitempty"`
	Branch       string            `json:"branch,omitempty"`
	BaseSHA      string            `json:"base_sha,omitempty"`
	Prepared     bool              `json:"prepared"`
	Cleaned      bool              `json:"cleaned"`
	Question     *Question         `json:"question,omitempty"`
	Decision     *Decision         `json:"decision,omitempty"`
	Error        string            `json:"error,omitempty"`
	CreatedAt    time.Time         `json:"created_at"`
	UpdatedAt    time.Time         `json:"updated_at"`
}

func (r Run) Terminal() bool {
	return r.Status == "succeeded" || r.Status == "failed" || r.Status == "canceled"
}

type Event struct {
	ID    int64           `json:"id"`
	RunID string          `json:"run_id"`
	Type  string          `json:"type"`
	Time  time.Time       `json:"time"`
	Data  json.RawMessage `json:"data"`
}
type Automation struct {
	ID         string `json:"id"`
	WorkflowID string `json:"workflow_id"`
	// Definitions are pinned when an automation is saved, not resolved at fire time.
	Revision         string            `json:"revision"`
	Workflow         Workflow          `json:"workflow"`
	Schedule         string            `json:"schedule,omitempty"`
	Event            string            `json:"event,omitempty"`
	GitHubRepository string            `json:"github_repository,omitempty"`
	Enabled          bool              `json:"enabled"`
	Inputs           map[string]string `json:"inputs,omitempty"`
	NextAt           *time.Time        `json:"next_at,omitempty"`
	LastRunID        string            `json:"last_run_id,omitempty"`
	LastFiredAt      *time.Time        `json:"last_fired_at,omitempty"`
	LastSkippedAt    *time.Time        `json:"last_skipped_at,omitempty"`
	CreatedAt        time.Time         `json:"created_at"`
	UpdatedAt        time.Time         `json:"updated_at"`
}

func newID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func digest(data []byte) string { h := sha256.Sum256(data); return hex.EncodeToString(h[:]) }
func now() time.Time            { return time.Now().UTC() }
