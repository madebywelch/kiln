package factory

import "testing"

func TestScheduleRejectsTimezoneDirectivesWithoutPanic(t *testing.T) {
	t.Parallel()
	for _, spec := range []string{
		"TZ=UTC\t*\t*\t*\t*",
		"CRON_TZ=UTC\t*\t*\t*\t*",
		"TZ=UTC * * * * *",
		"CRON_TZ=America/New_York * * * * *",
	} {
		t.Run(spec, func(t *testing.T) {
			defer func() {
				if value := recover(); value != nil {
					t.Errorf("schedule parsing panicked: %v", value)
				}
			}()
			if _, err := parseSchedule(spec); err == nil {
				t.Fatal("accepted timezone directive in UTC-only cron expression")
			}
		})
	}
}
