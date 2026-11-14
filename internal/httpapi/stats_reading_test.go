package httpapi

import (
	"encoding/json"
	"net/http"
	"testing"

	"pandalibrary/internal/stats"
)

func TestReadingHTTPAuthenticationAndArguments(t *testing.T) {
	f := newStatsHTTPFixture(t)
	path := "/api/v1/stats/reading?year=2026&timezone=Asia%2FShanghai"
	if got := authRequest(t, f.router, http.MethodGet, path, nil, nil); got.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d", got.Code)
	}
	response := authRequest(t, f.router, http.MethodGet, path, nil, f.cookie)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		response.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("reading = %d %s", response.Code, response.Body.String())
	}
	var got stats.ReadingResponse
	decoder := json.NewDecoder(response.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Year != 2026 || got.Timezone != "Asia/Shanghai" || len(got.Daily) != 365 ||
		len(got.Hours) != 288 || got.Books.Read != 1 || got.Books.ReadAndReading != 1 || len(got.Completions) != 0 {
		t.Fatalf("reading DTO = %+v", got.Books)
	}
	for _, query := range []string{
		"", "year=2026", "timezone=UTC", "year=0000&timezone=UTC",
		"year=9999&timezone=UTC", "year=26&timezone=UTC", "year=+2026&timezone=UTC",
		"year=2026&year=2025&timezone=UTC", "year=2026&timezone=UTC&timezone=UTC",
		"year=2026&timezone=Local", "year=2026&timezone=Unknown%2FZone",
		"year=2026&timezone=UTC&extra=1", "year=2026&timezone=UTC%20",
		"year=2026&timezone=%ZZ", "year=2026;timezone=UTC",
	} {
		response := authRequest(t, f.router, http.MethodGet, "/api/v1/stats/reading?"+query, nil, f.cookie)
		if response.Code != http.StatusBadRequest {
			t.Errorf("%q = %d %s", query, response.Code, response.Body.String())
		}
	}
}
