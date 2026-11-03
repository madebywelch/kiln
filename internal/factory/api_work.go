package factory

import (
	"context"

	"github.com/danielgtaylor/huma/v2"
)

type WorkPageInput struct {
	PageInput
	Status string `query:"status" enum:"open,completed,canceled"`
}

func registerWorkAPI(api huma.API, e *Engine) {
	register(api, "POST", "/v1/work", "create-work", "Create an immutable work contract with an editable handoff", func(ctx context.Context, in *struct {
		Key  string `header:"Idempotency-Key" maxLength:"200"`
		Body CreateWorkRequest
	}) (*Response[WorkItem], error) {
		return reply(e.CreateWork(in.Body, in.Key))
	})
	register(api, "GET", "/v1/work", "list-work", "List work items, oldest first", func(ctx context.Context, in *WorkPageInput) (*Response[[]WorkItem], error) {
		return reply(list[WorkItem](e.store, "work", in.Status, in.Limit, in.Offset))
	})
	register(api, "GET", "/v1/work/{id}", "get-work", "Read a work contract, handoff, and completion evidence", func(ctx context.Context, in *IDInput) (*Response[WorkItem], error) {
		return reply(e.GetWork(in.ID))
	})
	register(api, "PUT", "/v1/work/{id}/handoff", "update-work-handoff", "Replace the handoff using the current work revision", func(ctx context.Context, in *struct {
		IDInput
		Body UpdateWorkHandoffRequest
	}) (*Response[WorkItem], error) {
		return reply(e.UpdateWorkHandoff(in.ID, in.Body))
	})
	register(api, "POST", "/v1/work/{id}/complete", "complete-work", "Explicitly approve completion with successful verification evidence for every criterion", func(ctx context.Context, in *struct {
		IDInput
		Body CompleteWorkRequest
	}) (*Response[WorkItem], error) {
		return reply(e.CompleteWork(in.ID, in.Body))
	})
	register(api, "POST", "/v1/work/{id}/cancel", "cancel-work", "Cancel inactive work using the current work revision and a reason", func(ctx context.Context, in *struct {
		IDInput
		Body CancelWorkRequest
	}) (*Response[WorkItem], error) {
		return reply(e.CancelWork(in.ID, in.Body))
	})
	register(api, "GET", "/v1/work/{id}/runs", "list-work-runs", "List linked run summaries, oldest first", func(ctx context.Context, in *struct {
		IDInput
		PageInput
	}) (*Response[[]RunSummary], error) {
		runs, err := e.ListWorkRuns(in.ID, in.Limit, in.Offset)
		result := []RunSummary{}
		for _, r := range runs {
			result = append(result, summary(r))
		}
		return reply(result, err)
	})
	register(api, "GET", "/v1/work/{id}/events", "list-work-events", "Replay durable work events after a cursor", func(ctx context.Context, in *struct {
		IDInput
		After int64 `query:"after" minimum:"0" default:"0"`
		Limit int   `query:"limit" default:"100" minimum:"1" maximum:"1000"`
	}) (*Response[[]WorkEvent], error) {
		return reply(e.WorkEvents(in.ID, in.After, in.Limit))
	})
}
