package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/db"
	"pandalibrary/internal/stats"

	"github.com/go-chi/chi/v5"
)

type statsHTTPFixture struct {
	router  http.Handler
	handler *statsHTTP
	db      *db.DB
	cookie  *http.Cookie
	logs    *bytes.Buffer
}

func newStatsHTTPFixture(t *testing.T) statsHTTPFixture {
	t.Helper()
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES
			(1, 102, 1, 1), (2, 102, 1, 1)`,
		`INSERT INTO reading_sessions
			(id, user_id, book_id, source, started_at, ended_at, active_seconds, created_at) VALUES
			('00000000-0000-7000-8000-000000000001', 2, 101, 'web', 1769792400000, 1769792460000, 60, 1),
			('00000000-0000-7000-8000-000000000002', 2, 102, 'web', 1769792400000, 1769792460000, 60, 1),
			('00000000-0000-7000-8000-000000000003', 2, 103, 'web', 1769792400000, 1769792460000, 60, 1),
			('00000000-0000-7000-8000-000000000004', 1, 101, 'web', 1769792400000, 1769792460000, 60, 1),
			('00000000-0000-7000-8000-000000000005', 1, 102, 'web', 1769792400000, 1769792460000, 60, 1),
			('00000000-0000-7000-8000-000000000006', 1, 103, 'web', 1769792400000, 1769792460000, 60, 1)`,
		`INSERT INTO user_books (user_id, book_id, status, finished_at, updated_at, rev) VALUES
			(2, 101, 'finished', 1769792400000, 1, 1), (2, 102, 'finished', 1769792400000, 1, 1),
			(2, 103, 'finished', 1769792400000, 1, 1), (1, 101, 'finished', 1769792400000, 1, 1),
			(1, 102, 'finished', 1769792400000, 1, 1), (1, 103, 'finished', 1769792400000, 1, 1)`,
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	token := base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	hash := sha256.Sum256([]byte(token))
	now := time.Now()
	if _, err := databases.Writer.ExecContext(ctx, `INSERT INTO sessions
		(token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
		VALUES (?, 2, ?, ?, ?, '', '')`, hash[:], now.UnixMilli(), now.Add(time.Hour).UnixMilli(), now.UnixMilli()); err != nil {
		t.Fatal(err)
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	service, err := stats.NewService(databases.Reader)
	if err != nil {
		t.Fatal(err)
	}
	logs := &bytes.Buffer{}
	logger := slog.New(slog.NewTextHandler(logs, nil))
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	StatsMount(service, authentication, logger)(router, protection)
	return statsHTTPFixture{
		router: router, handler: &statsHTTP{service: service, logger: logger}, db: databases,
		cookie: &http.Cookie{Name: sessionCookieName, Value: token}, logs: logs,
	}
}

func TestStatsHTTPAuthenticatedStableDTOAndVisibility(t *testing.T) {
	f := newStatsHTTPFixture(t)
	path := "/api/v1/stats?from=2026-01-31&to=2026-02-01&timezone=Asia%2FShanghai"
	unauthenticated := authRequest(t, f.router, http.MethodGet, path, nil, nil)
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d %s", unauthenticated.Code, unauthenticated.Body.String())
	}
	for _, test := range []struct {
		userID int64
		count  int64
	}{
		{2, 1}, {1, 2},
	} {
		if _, err := f.db.Writer.ExecContext(context.Background(), "UPDATE sessions SET user_id = ?", test.userID); err != nil {
			t.Fatal(err)
		}
		response := authRequest(t, f.router, http.MethodGet, path, nil, f.cookie)
		if response.Code != http.StatusOK ||
			response.Header().Get("Content-Type") != "application/json; charset=utf-8" ||
			response.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("stats = %d %s headers %v", response.Code, response.Body.String(), response.Header())
		}
		var got stats.Response
		decoder := json.NewDecoder(response.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&got); err != nil {
			t.Fatal(err)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF {
			t.Fatalf("extra response data: %v", err)
		}
		if got.Timezone != "Asia/Shanghai" || got.From != "2026-01-31" || got.To != "2026-02-01" ||
			!reflect.DeepEqual(got.Daily, []stats.Day{
				{Date: "2026-01-31", ActiveSeconds: 60 * test.count, SessionCount: test.count},
				{Date: "2026-02-01"},
			}) || !reflect.DeepEqual(got.FinishedPerMonth, []stats.FinishedMonth{
			{Month: "2026-01", BooksFinished: test.count}, {Month: "2026-02"},
		}) || got.Streaks != (stats.Streaks{LongestDays: 1}) || int64(len(got.TimePerBook)) != test.count {
			t.Fatalf("user %d DTO = %+v", test.userID, got)
		}
		for _, book := range got.TimePerBook {
			if book.BookID == 102 || book.Title == "Hidden" || book.Authors == nil || book.ActiveSeconds != 60 ||
				book.SessionCount != 1 || (test.userID == 2 && book.BookID != 101) {
				t.Fatalf("unexpected book = %+v", book)
			}
		}
	}
	empty := authRequest(t, f.router, http.MethodGet,
		"/api/v1/stats?from=2026-02-02&to=2026-02-02&timezone=UTC", nil, f.cookie)
	if empty.Code != http.StatusOK || !strings.Contains(empty.Body.String(), `"time_per_book":[]`) ||
		strings.Contains(empty.Body.String(), "null") {
		t.Fatalf("empty response = %d %s", empty.Code, empty.Body.String())
	}
}

func TestStatsHTTPStrictQueryValidation(t *testing.T) {
	f := newStatsHTTPFixture(t)
	valid := "from=2026-01-01&to=2026-01-01&timezone=UTC"
	for _, query := range []string{
		"", "from=2026-01-01", "from=2026-01-01&to=2026-01-01",
		"from=&to=2026-01-01&timezone=UTC",
		"from=2026-01-01&to=&timezone=UTC",
		"from=2026-01-01&to=2026-01-01&timezone=",
		valid + "&from=2026-01-01", valid + "&to=2026-01-01", valid + "&timezone=UTC",
		valid + "&user_id=1", valid + "&is_admin=1", valid + "&unknown=1",
		"from=2026-01-01&to=2026-01-01&wrong=UTC",
		valid + "&x=%", valid + ";x=1",
		"from=2026-02-30&to=2026-03-01&timezone=UTC",
		"from=2026-01-01&to=2026-1-01&timezone=UTC",
		"from=2026-01-02&to=2026-01-01&timezone=UTC",
		"from=2024-01-01&to=2025-01-01&timezone=UTC",
		"from=2026-01-01&to=2026-01-01&timezone=Unknown%2FZone",
		"from=2026-01-01&to=2026-01-01&timezone=Local",
		"from=2026-01-01&to=2026-01-01&timezone=%2Fetc%2Fpasswd",
	} {
		t.Run(query, func(t *testing.T) {
			response := authRequest(t, f.router, http.MethodGet, "/api/v1/stats?"+query, nil, f.cookie)
			if response.Code != http.StatusBadRequest ||
				response.Header().Get("Content-Type") != "application/problem+json" ||
				response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("response = %d %s headers %v", response.Code, response.Body.String(), response.Header())
			}
		})
	}
	maximum := authRequest(t, f.router, http.MethodGet,
		"/api/v1/stats?from=2024-01-01&to=2024-12-31&timezone=America%2FNew_York", nil, f.cookie)
	var got stats.Response
	if err := json.Unmarshal(maximum.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if maximum.Code != http.StatusOK || len(got.Daily) != 366 || len(got.FinishedPerMonth) != 12 {
		t.Fatalf("maximum range = %d, %d days, %d months", maximum.Code, len(got.Daily), len(got.FinishedPerMonth))
	}
}

func TestStatsHTTPFailurePaths(t *testing.T) {
	for _, test := range []string{"missing viewer", "canceled", "database"} {
		t.Run(test, func(t *testing.T) {
			f := newStatsHTTPFixture(t)
			request := httptest.NewRequest(http.MethodGet,
				"/api/v1/stats?from=2026-01-01&to=2026-01-01&timezone=UTC", nil)
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
			f.handler.get(response, request.WithContext(ctx))
			if response.Code != want || response.Header().Get("Content-Type") != "application/problem+json" ||
				response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "sql:") {
				t.Fatalf("failure = %d %s headers %v", response.Code, response.Body.String(), response.Header())
			}
			if want == http.StatusInternalServerError && !strings.Contains(f.logs.String(), "stats request failed") {
				t.Fatalf("failure was not logged: %s", f.logs.String())
			}
		})
	}
}
