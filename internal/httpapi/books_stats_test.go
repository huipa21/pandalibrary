package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/stats"
)

func TestBooksStatsHTTPAuthenticationDTOAndQuery(t *testing.T) {
	f := newStatsHTTPFixture(t)
	path := "/api/v1/stats/books?timezone=Asia%2FShanghai"
	if got := authRequest(t, f.router, http.MethodGet, path, nil, nil); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d %s", got.Code, got.Body.String())
	}
	response := authRequest(t, f.router, http.MethodGet, path, nil, f.cookie)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" ||
		strings.Contains(response.Body.String(), "null") {
		t.Fatalf("response = %d %s, headers %v", response.Code, response.Body.String(), response.Header())
	}
	var got stats.BooksResponse
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.TotalBooks != 1 || got.Timezone != "Asia/Shanghai" || len(got.PageCounts) != 7 ||
		len(got.AddedOverTime) != 1 || got.AddedOverTime[0].Count != 1 ||
		len(got.Languages) != 1 || got.Languages[0].Key != "unknown" {
		t.Fatalf("DTO = %+v", got)
	}
	for _, query := range []string{"", "timezone=", "timezone=UTC&timezone=UTC",
		"timezone=UTC&user_id=1", "timezone=UTC&is_admin=1", "zone=UTC",
		"timezone=UTC&x=%", "timezone=UTC;x=1", "timezone=Local",
		"timezone=Unknown%2FZone", "timezone=%20UTC"} {
		t.Run(query, func(t *testing.T) {
			got := authRequest(t, f.router, http.MethodGet, "/api/v1/stats/books?"+query, nil, f.cookie)
			if got.Code != http.StatusBadRequest || got.Header().Get("Cache-Control") != "no-store" ||
				got.Header().Get("Content-Type") != "application/problem+json" {
				t.Fatalf("invalid query = %d %s", got.Code, got.Body.String())
			}
		})
	}
	if got := authRequest(t, f.router, http.MethodPost, path, nil, f.cookie); got.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST = %d %s", got.Code, got.Body.String())
	}
}

func TestBooksStatsHTTPFailurePaths(t *testing.T) {
	for _, failure := range []string{"missing viewer", "canceled", "database"} {
		t.Run(failure, func(t *testing.T) {
			f := newStatsHTTPFixture(t)
			request := httptest.NewRequest(http.MethodGet, "/api/v1/stats/books?timezone=UTC", nil)
			ctx := request.Context()
			want := http.StatusInternalServerError
			if failure == "missing viewer" {
				want = http.StatusUnauthorized
			} else {
				ctx = context.WithValue(ctx, viewerContextKey{}, auth.User{ID: 2, Role: "user"})
			}
			if failure == "canceled" {
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if failure == "database" {
				if err := f.db.Reader.Close(); err != nil {
					t.Fatal(err)
				}
			}
			response := httptest.NewRecorder()
			f.handler.books(response, request.WithContext(ctx))
			if response.Code != want || response.Header().Get("Cache-Control") != "no-store" ||
				strings.Contains(response.Body.String(), "sql:") {
				t.Fatalf("failure = %d %s", response.Code, response.Body.String())
			}
		})
	}
}
