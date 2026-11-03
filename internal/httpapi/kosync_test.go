package httpapi

import (
	"context"
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/db"
	"pandalibrary/internal/kosync"
	"pandalibrary/internal/reading"
)

type kosyncHTTPFixture struct {
	database *db.DB
	auth     *auth.Service
	handler  http.Handler
	key      string
	password auth.AppPassword
}

func newKOSyncHTTPFixture(t *testing.T) *kosyncHTTPFixture {
	t.Helper()
	ctx := context.Background()
	database := openHTTPTestDatabase(t)
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'reader', 'x', 'user', 1, 1), (2, 'other', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 1, 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
			(101, 10, 'Visible', 'visible', 1, 1), (102, 10, 'Hidden', 'hidden', 1, 1),
			(103, 20, 'Private', 'private', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (1, 102, 2, 1)`,
	} {
		if _, err := database.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 3; i++ {
		digest := strings.Repeat(string(rune('a'+i)), 32)
		if _, err := database.Writer.ExecContext(ctx, `INSERT INTO book_files
			(id, book_id, sha256, format, size_bytes, original_filename, koreader_md5, created_at)
			VALUES (?, ?, ?, 'epub', 1, 'book.epub', ?, 1)`, 201+i, 101+i, strings.Repeat(digest, 2), digest); err != nil {
			t.Fatal(err)
		}
	}
	authentication, err := auth.NewService(ctx, database.Writer, database.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	password, err := authentication.CreateAppPassword(ctx, 1, "kosync", "KOReader")
	if err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("%x", md5.Sum([]byte(strings.ReplaceAll(password.Secret, "-", ""))))
	state, err := reading.NewService(database.Writer, database.Reader)
	if err != nil {
		t.Fatal(err)
	}
	service, err := kosync.NewService(database.Writer, database.Reader, state, kosync.Options{})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewRouter(RouterOptions{
		Database: database.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("SPA")}},
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), MaxBodyBytes: 1 << 20,
		Mounts: []Mount{KOSyncMount(service, authentication, slog.New(slog.NewTextHandler(io.Discard, nil)))},
	})
	if err != nil {
		t.Fatal(err)
	}
	return &kosyncHTTPFixture{database, authentication, handler, key, password}
}

func (f *kosyncHTTPFixture) request(method, path, body string, headers http.Header) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Auth-User", "reader")
	request.Header.Set("X-Auth-Key", f.key)
	for name, values := range headers {
		request.Header.Del(name)
		for _, value := range values {
			request.Header.Add(name, value)
		}
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func assertKOSyncResponse(t *testing.T, response *httptest.ResponseRecorder, status int, want any) {
	t.Helper()
	var got any
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatalf("non-JSON protocol response: %s (%v)", response.Body.String(), err)
	}
	if response.Code != status || response.Header().Get("Content-Type") != "application/json" || !reflect.DeepEqual(got, want) {
		t.Fatalf("response = %d %s %s; want %d %v", response.Code,
			response.Header().Get("Content-Type"), response.Body.String(), status, want)
	}
}

func TestKOSyncProtocolGolden(t *testing.T) {
	f := newKOSyncHTTPFixture(t)
	raw, err := os.ReadFile(filepath.Join("testdata", "kosync.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name, Method, Path, Auth, Body string
		Status                         int
		Response                       map[string]any
	}
	if err := json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			headers := http.Header{}
			switch tc.Auth {
			case "none":
				headers["X-Auth-User"], headers["X-Auth-Key"] = nil, nil
			case "invalid":
				headers.Set("X-Auth-Key", strings.Repeat("0", 32))
			}
			before := time.Now().UnixMilli()
			response := f.request(tc.Method, tc.Path, tc.Body, headers)
			if _, ok := tc.Response["timestamp"]; ok {
				var record kosync.Record
				if err := json.Unmarshal(response.Body.Bytes(), &record); err != nil {
					t.Fatal(err)
				}
				var stored int64
				if err := f.database.Reader.QueryRow(`SELECT updated_at FROM kosync_progress
					WHERE user_id = 1 AND document = ?`, record.Document).Scan(&stored); err != nil {
					t.Fatal(err)
				}
				if record.Timestamp != float64(stored)/1000 ||
					(tc.Method == http.MethodPut && (stored < before || stored > time.Now().UnixMilli())) {
					t.Fatalf("wire timestamp %v does not match server time %d", record.Timestamp, stored)
				}
				tc.Response["timestamp"] = record.Timestamp
			}
			assertKOSyncResponse(t, response, tc.Status, tc.Response)
		})
	}
	var progress, sessions int
	if err := f.database.Reader.QueryRow("SELECT count(*) FROM reading_progress").Scan(&progress); err != nil {
		t.Fatal(err)
	}
	if err := f.database.Reader.QueryRow("SELECT count(*) FROM reading_sessions").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if progress != 1 || sessions != 1 {
		t.Fatalf("known/unknown bridge counts = %d/%d, want 1/1", progress, sessions)
	}
}

func TestKOSyncCredentialRejection(t *testing.T) {
	f := newKOSyncHTTPFixture(t)
	ctx := context.Background()
	opds, err := f.auth.CreateAppPassword(ctx, 1, "opds", "OPDS")
	if err != nil {
		t.Fatal(err)
	}
	opdsMD5 := fmt.Sprintf("%x", md5.Sum([]byte(strings.ReplaceAll(opds.Secret, "-", ""))))
	for _, tc := range []struct {
		name    string
		headers http.Header
	}{
		{"missing", http.Header{"X-Auth-User": nil, "X-Auth-Key": nil}},
		{"missing-user", http.Header{"X-Auth-User": nil}},
		{"missing-key", http.Header{"X-Auth-Key": nil}},
		{"wrong-user", http.Header{"X-Auth-User": {"other"}}},
		{"unknown-user", http.Header{"X-Auth-User": {"nobody"}}},
		{"oversized-user", http.Header{"X-Auth-User": {strings.Repeat("a", 129)}}},
		{"plaintext", http.Header{"X-Auth-Key": {f.password.Secret}}},
		{"nonhex", http.Header{"X-Auth-Key": {strings.Repeat("z", 32)}}},
		{"wrong-kind", http.Header{"X-Auth-Key": {opdsMD5}}},
		{"duplicate-user", http.Header{"X-Auth-User": {"reader", "reader"}}},
		{"duplicate-key", http.Header{"X-Auth-Key": {f.key, f.key}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, endpoint := range []struct{ method, path string }{
				{http.MethodGet, "/kosync/users/auth"},
				{http.MethodGet, "/kosync/syncs/progress/unknown"},
				{http.MethodPut, "/kosync/syncs/progress"},
			} {
				response := f.request(endpoint.method, endpoint.path, `{}`, tc.headers)
				assertKOSyncResponse(t, response, 401, map[string]any{"message": "Unauthorized", "code": float64(2001)})
			}
			valid := f.request(http.MethodGet, "/kosync/users/auth", "", nil)
			assertKOSyncResponse(t, valid, 200, map[string]any{"authorized": "OK"})
		})
	}
	valid := f.request(http.MethodGet, "/kosync/users/auth", "", http.Header{"X-Auth-Key": {strings.ToUpper(f.key)}})
	assertKOSyncResponse(t, valid, 200, map[string]any{"authorized": "OK"})
	if _, err := f.database.Writer.Exec("UPDATE users SET disabled = 1 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	disabled := f.request(http.MethodGet, "/kosync/users/auth", "", nil)
	assertKOSyncResponse(t, disabled, 401, map[string]any{"message": "Unauthorized", "code": float64(2001)})
	if _, err := f.database.Writer.Exec("UPDATE users SET disabled = 0 WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if err := f.auth.RevokeAppPassword(ctx, 1, f.password.ID); err != nil {
		t.Fatal(err)
	}
	revoked := f.request(http.MethodGet, "/kosync/users/auth", "", nil)
	assertKOSyncResponse(t, revoked, 401, map[string]any{"message": "Unauthorized", "code": float64(2001)})
}

func TestKOSyncAuthenticationRateLimit(t *testing.T) {
	f := newKOSyncHTTPFixture(t)
	for i := 0; i < 6; i++ {
		response := f.request(http.MethodGet, "/kosync/users/auth", "", http.Header{"X-Auth-Key": {"invalid"}})
		status := http.StatusUnauthorized
		if i == 5 {
			status = http.StatusTooManyRequests
			if response.Header().Get("Retry-After") != "600" {
				t.Fatal("rate limit did not provide retry interval")
			}
		}
		assertKOSyncResponse(t, response, status, map[string]any{"message": "Unauthorized", "code": float64(2001)})
	}
	// Device failures must not block other client addresses or public endpoints.
	request := httptest.NewRequest(http.MethodGet, "/kosync/users/auth", nil)
	request.RemoteAddr = "192.0.2.11:1234"
	request.Header.Set("X-Auth-User", "reader")
	request.Header.Set("X-Auth-Key", f.key)
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	assertKOSyncResponse(t, response, 200, map[string]any{"authorized": "OK"})
	health := f.request(http.MethodGet, "/kosync/healthcheck", "", nil)
	assertKOSyncResponse(t, health, 200, map[string]any{"state": "OK"})
}

func TestKOSyncPersistenceFailureIsNotAcknowledged(t *testing.T) {
	f := newKOSyncHTTPFixture(t)
	if _, err := f.database.Writer.Exec(`CREATE TRIGGER reject_kosync_session BEFORE INSERT ON reading_sessions
		BEGIN SELECT RAISE(ABORT, 'internal failure must not reach the device'); END`); err != nil {
		t.Fatal(err)
	}
	response := f.request(http.MethodPut, "/kosync/syncs/progress",
		`{"document":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","progress":"/body/a","percentage":0.5,"device":"Kobo"}`, nil)
	assertKOSyncResponse(t, response, 502, map[string]any{"message": "Unknown server error.", "code": float64(2000)})
	missing := f.request(http.MethodGet, "/kosync/syncs/progress/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "", nil)
	assertKOSyncResponse(t, missing, 200, map[string]any{})
}

func TestKOSyncFieldLimitsAndVisibility(t *testing.T) {
	f := newKOSyncHTTPFixture(t)
	valid := map[string]any{"document": "unknown", "progress": "/body/a", "percentage": 0.5, "device": "Kobo"}
	for _, tc := range []struct {
		name, field  string
		value        any
		status, code int
	}{
		{"long-document", "document", strings.Repeat("a", 65), 403, 2004},
		{"long-progress", "progress", strings.Repeat("p", 8193), 403, 2003},
		{"long-device", "device", strings.Repeat("d", 129), 403, 2003},
		{"long-device-id", "device_id", strings.Repeat("d", 129), 403, 2003},
		{"missing-progress", "progress", nil, 403, 2003},
		{"missing-percentage", "percentage", nil, 403, 2003},
		{"missing-device", "device", nil, 403, 2003},
		{"wrong-type", "progress", 42, 403, 2003},
		{"negative-percentage", "percentage", -0.1, 403, 2003},
		{"nul", "progress", "\x00", 403, 2003},
		{"oversized-body", "progress", strings.Repeat("p", kosync.MaxRequestBytes), 413, 2003},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := make(map[string]any)
			for k, v := range valid {
				body[k] = v
			}
			body[tc.field] = tc.value
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			response := f.request(http.MethodPut, "/kosync/syncs/progress", string(raw), nil)
			message := "Invalid request"
			if tc.code == 2004 {
				message = "Field 'document' not provided."
			}
			assertKOSyncResponse(t, response, tc.status, map[string]any{"message": message, "code": float64(tc.code)})
		})
	}
	for _, document := range []string{"unknown", strings.Repeat("b", 32), strings.Repeat("c", 32)} {
		body := fmt.Sprintf(`{"document":%q,"progress":"/body/exact","percentage":0.5,"device":"Kobo"}`, document)
		put := f.request(http.MethodPut, "/kosync/syncs/progress", body, nil)
		if put.Code != 200 {
			t.Fatalf("inaccessible/unknown PUT = %d %s", put.Code, put.Body.String())
		}
		get := f.request(http.MethodGet, "/kosync/syncs/progress/"+document, "", nil)
		var record kosync.Record
		if err := json.Unmarshal(get.Body.Bytes(), &record); err != nil {
			t.Fatal(err)
		}
		assertKOSyncResponse(t, get, 200, map[string]any{
			"document": document, "progress": "/body/exact", "percentage": 0.5,
			"device": "Kobo", "device_id": "", "timestamp": record.Timestamp,
		})
	}
	for _, table := range []string{"reading_progress", "reading_sessions"} {
		var count int
		if err := f.database.Reader.QueryRow("SELECT count(*) FROM " + table).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("inaccessible/unknown writes created %d %s rows", count, table)
		}
	}
}
