package factory

import (
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
)

func TestStoreRejectsUnrecognizedSchemaWithoutMutation(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name string
		meta string
	}{
		{"old", "CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES(2);"},
		{"future", "CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES(4);"},
		{"empty", "CREATE TABLE meta(version INTEGER);"},
		{"multiple", "CREATE TABLE meta(version INTEGER); INSERT INTO meta VALUES(3),(4);"},
		{"malformed", "CREATE TABLE meta(other TEXT);"},
		{"missing", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "state.db")
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.Exec(tc.meta + `CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES('keep'); CREATE INDEX runs_status ON preserved(value);`); err != nil {
				t.Fatal(err)
			}
			snapshot := func() []string {
				t.Helper()
				rows, err := db.Query("SELECT name || ':' || sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
				if err != nil {
					t.Fatal(err)
				}
				defer rows.Close()
				var result []string
				for rows.Next() {
					var value string
					if err := rows.Scan(&value); err != nil {
						t.Fatal(err)
					}
					result = append(result, value)
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				return result
			}
			before := snapshot()
			for range 2 {
				s, err := OpenStore(dir)
				if err == nil {
					s.Close()
					t.Error("accepted an unrecognized database schema")
				}
				if after := snapshot(); !reflect.DeepEqual(before, after) {
					t.Errorf("schema changed on rejected startup: before=%v after=%v", before, after)
				}
			}
			var mode, value string
			if err := db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "delete" {
				t.Errorf("journal mode changed: %q, %v", mode, err)
			}
			if err := db.QueryRow("SELECT value FROM preserved").Scan(&value); err != nil || value != "keep" {
				t.Errorf("existing data changed: %q, %v", value, err)
			}
		})
	}
}

func TestStoreInitializesEmptyDatabaseAndReopens(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	for range 2 {
		s, err := OpenStore(dir)
		if err != nil {
			t.Fatal(err)
		}
		var version int
		if err := s.db.QueryRow("SELECT version FROM meta").Scan(&version); err != nil || version != 3 {
			t.Errorf("schema version=%d, err=%v", version, err)
		}
		if err := s.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
