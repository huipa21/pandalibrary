package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/stats"
)

func TestStatsHistoryHTTPContractAndAuthentication(t *testing.T) {
	f := newStatsHTTPFixture(t)
	path := "/api/v1/stats/history?year=2026&timezone=Asia%2FShanghai&limit=1"
	response := authRequest(t, f.router, http.MethodGet, path, nil, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d %s", response.Code, response.Body.String())
	}
	for _, timezone := range []string{"UTC", "Asia%2FShanghai"} {
		response = authRequest(t, f.router, http.MethodGet,
			"/api/v1/stats/history?year=2026&timezone="+timezone+"&limit=1", nil, f.cookie)
		if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
			!strings.HasPrefix(response.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("history = %d %s headers %v", response.Code, response.Body.String(), response.Header())
		}
		var got stats.HistoryResponse
		if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		date := "2026-01-30"
		if timezone != "UTC" {
			date = "2026-01-31"
		}
		if got.Year != 2026 || len(got.Items) != 1 || got.NextCursor != nil ||
			got.Items[0].Date != date || got.Items[0].BookID != 101 || got.Items[0].Title != "Visible" ||
			got.Items[0].Cycle != 1 || got.Items[0].Authors == nil || got.Items[0].CoverURL != nil ||
			got.Items[0].ActiveSeconds != 60 || got.Items[0].SessionCount != 1 ||
			got.Items[0].DayActiveSeconds != 60 || got.Items[0].DaySessionCount != 1 ||
			got.Summary.Books != 1 || got.Summary.SessionCount != 1 || len(got.Summary.Months) != 12 {
			t.Fatalf("history = %+v", got)
		}
		var object map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &object); err != nil {
			t.Fatal(err)
		}
		if len(object) != 5 || string(object["next_cursor"]) != "null" {
			t.Fatalf("contract = %s", response.Body.String())
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(object["items"], &rows); err != nil || len(rows[0]) != 10 ||
			string(rows[0]["authors"]) != "[]" || string(rows[0]["cover_url"]) != "null" {
			t.Fatalf("row contract = %s (%v)", object["items"], err)
		}
	}
	// The second page has no effect on full-year, monthly, or day totals.
	if _, err := f.db.Writer.Exec(`INSERT INTO reading_sessions
		(id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at)
		VALUES ('00000000-0000-7000-8000-000000000099', 2, 101, 'web', 1769878800000, 1769878920000, 120, 1)`); err != nil {
		t.Fatal(err)
	}
	response = authRequest(t, f.router, http.MethodGet, path, nil, f.cookie)
	var first stats.HistoryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil || first.NextCursor == nil {
		t.Fatalf("first page = %s (%v)", response.Body.String(), err)
	}
	response = authRequest(t, f.router, http.MethodGet, path+"&cursor="+*first.NextCursor, nil, f.cookie)
	var second stats.HistoryResponse
	if err := json.Unmarshal(response.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusOK || second.NextCursor != nil || len(second.Items) != 1 ||
		first.Items[0].Date <= second.Items[0].Date || first.Summary.SessionCount != 2 ||
		first.Summary.ActiveSeconds != 180 || !reflect.DeepEqual(first.Summary, second.Summary) {
		t.Fatalf("pages = %+v / %+v", first, second)
	}
}

func TestStatsHistoryHTTPInvalidInputs(t *testing.T) {
	f := newStatsHTTPFixture(t)
	for _, query := range []string{
		"", "year=2026&timezone=UTC", "year=2026&limit=50", "timezone=UTC&limit=50",
		"year=0&timezone=UTC&limit=50", "year=9999&timezone=UTC&limit=50",
		"year=2026&timezone=UTC&limit=0", "year=2026&timezone=UTC&limit=101",
		"year=2026&timezone=Local&limit=50", "year=2026&timezone=Missing%2FZone&limit=50",
		"year=2026&timezone=UTC&limit=50&cursor=", "year=2026&timezone=UTC&limit=50&cursor=garbage",
		"year=2026&year=2026&timezone=UTC&limit=50", "year=2026&timezone=UTC&timezone=UTC&limit=50",
		"year=2026&timezone=UTC&limit=50&limit=50", "year=2026&timezone=UTC&limit=50&extra=1",
		"year=2026&timezone=UTC&limit=50&cursor=a&cursor=b", "year=2026&timezone=%ZZ&limit=50",
		"year=2026&timezone=UTC&limit=1.5", "year=2026&timezone=UTC&limit=+1",
		"year=2026&timezone=UTC&limit=50;ignored=1", "year=02026&timezone=UTC&limit=50",
		"year=99999999999999999999999&timezone=UTC&limit=50",
	} {
		t.Run(query, func(t *testing.T) {
			response := authRequest(t, f.router, http.MethodGet, "/api/v1/stats/history?"+query, nil, f.cookie)
			if response.Code != http.StatusBadRequest || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestStatsHistoryHTTPFailurePaths(t *testing.T) {
	for _, test := range []string{"missing viewer", "canceled", "database"} {
		t.Run(test, func(t *testing.T) {
			f := newStatsHTTPFixture(t)
			request := httptest.NewRequest(http.MethodGet, "/api/v1/stats/history?year=2026&timezone=UTC&limit=50", nil)
			ctx := request.Context()
			want := http.StatusInternalServerError
			if test == "missing viewer" {
				want = http.StatusUnauthorized
			} else {
				ctx = context.WithValue(ctx, viewerContextKey{}, auth.User{ID: 2, Role: "user"})
			}
			if test == "canceled" {
				canceled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = canceled
			}
			if test == "database" {
				if err := f.db.Reader.Close(); err != nil {
					t.Fatal(err)
				}
			}
			response := httptest.NewRecorder()
			f.handler.history(response, request.WithContext(ctx))
			if response.Code != want || response.Header().Get("Cache-Control") != "no-store" ||
				response.Header().Get("Content-Type") != "application/problem+json" ||
				strings.Contains(response.Body.String(), "sql:") {
				t.Fatalf("failure = %d %s", response.Code, response.Body.String())
			}
			if want == http.StatusInternalServerError && !strings.Contains(f.logs.String(), "stats history request failed") {
				t.Fatalf("failure not logged: %s", f.logs.String())
			}
		})
	}
}
