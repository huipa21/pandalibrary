package httpapi

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"pandalibrary/internal/auth"

	"github.com/go-chi/chi/v5"
)

func adminHTTPTest(t *testing.T) (http.Handler, *auth.Service, *http.Cookie, *http.Cookie) {
	t.Helper()
	databases := openHTTPTestDatabase(t)
	service, err := auth.NewService(t.Context(), databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	var cookies []*http.Cookie
	for _, role := range []string{"admin", "user"} {
		if _, err := service.CreateUser(t.Context(), auth.CreateUserInput{
			Username: role, Role: role, Password: "correct horse battery",
		}); err != nil {
			t.Fatal(err)
		}
		session, err := service.Login(t.Context(), role, "correct horse battery", "", "")
		if err != nil {
			t.Fatal(err)
		}
		cookies = append(cookies, &http.Cookie{Name: sessionCookieName, Value: session.Token})
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	router := chi.NewRouter()
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	AdminUsersMount(service, logger)(router, protection)
	return router, service, cookies[0], cookies[1]
}

func TestAdminUsersHTTPAuthorizationAndOrigin(t *testing.T) {
	router, service, admin, reader := adminHTTPTest(t)
	app, err := service.CreateAppPassword(t.Context(), 1, "opds", "Device")
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []struct {
		method, path, body string
	}{
		{"GET", "/api/v1/admin/users", ""},
		{"GET", "/api/v1/admin/users/2", ""},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"correct horse battery"}`},
		{"PATCH", "/api/v1/admin/users/2", `{"display_name":"Changed"}`},
		{"DELETE", "/api/v1/admin/users/2", ""},
		{"POST", "/api/v1/admin/users/2/reset-password", `{"password":"replacement password"}`},
		{"POST", "/api/v1/admin/users/2/revoke-credentials", `{}`},
	} {
		t.Run(endpoint.method+" "+endpoint.path, func(t *testing.T) {
			for _, actor := range []struct {
				cookie *http.Cookie
				want   int
			}{{nil, 401}, {reader, 403}, {&http.Cookie{Name: sessionCookieName, Value: "invalid"}, 401}} {
				request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
				if actor.cookie != nil {
					request.AddCookie(actor.cookie)
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != actor.want || !strings.Contains(response.Header().Get("Content-Type"), "application/problem+json") {
					t.Fatalf("authorization = %d %s, want %d", response.Code, response.Body, actor.want)
				}
			}
			basic := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
			basic.SetBasicAuth("admin", app.Secret)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, basic)
			if response.Code != 401 {
				t.Fatalf("app password accepted as browser auth: %d", response.Code)
			}
			if endpoint.method != "GET" {
				for _, header := range []string{"Origin", "Sec-Fetch-Site"} {
					request := httptest.NewRequest(endpoint.method, endpoint.path, strings.NewReader(endpoint.body))
					request.AddCookie(admin)
					value := "https://evil.example"
					if header == "Sec-Fetch-Site" {
						value = "cross-site"
					}
					request.Header.Set(header, value)
					response := httptest.NewRecorder()
					router.ServeHTTP(response, request)
					if response.Code != 403 {
						t.Fatalf("cross-origin %s: %d %s", header, response.Code, response.Body)
					}
				}
			}
		})
	}
}

func TestAdminUsersHTTPCRUDAndSafeDTO(t *testing.T) {
	router, _, admin, _ := adminHTTPTest(t)
	created := authRequest(t, router, "POST", "/api/v1/admin/users", map[string]string{
		"username": "reader", "display_name": "Reader", "password": "correct horse battery",
		"role": "user", "locale": "zh",
	}, admin)
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	var result struct {
		User auth.AdminUser `json:"user"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/v1/admin/users/%d", result.User.ID)
	if result.User.ID < 1 || result.User.Disabled || result.User.Locale != "zh" {
		t.Fatalf("created: %+v", result.User)
	}
	for _, endpoint := range []string{path, "/api/v1/admin/users?limit=1"} {
		response := authRequest(t, router, "GET", endpoint, nil, admin)
		if response.Code != 200 {
			t.Fatalf("get/list: %d %s", response.Code, response.Body)
		}
		for _, secret := range []string{"password", "token", "session", "hash", "correct horse"} {
			if strings.Contains(response.Body.String(), secret) {
				t.Fatalf("unsafe account response: %s", response.Body)
			}
		}
	}
	var page auth.AdminUsersPage
	first := authRequest(t, router, "GET", "/api/v1/admin/users?limit=1", nil, admin)
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil || len(page.Items) != 1 || page.NextCursor == nil {
		t.Fatalf("first page: %s, %v", first.Body, err)
	}
	second := authRequest(t, router, "GET", "/api/v1/admin/users?limit=1&cursor="+url.QueryEscape(*page.NextCursor), nil, admin)
	var next auth.AdminUsersPage
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil || len(next.Items) != 1 || next.Items[0].ID == page.Items[0].ID {
		t.Fatalf("second page: %s, %v", second.Body, err)
	}
	patched := authRequest(t, router, "PATCH", path, map[string]string{"display_name": ""}, admin)
	if patched.Code != 200 {
		t.Fatalf("patch: %d %s", patched.Code, patched.Body)
	}
	if err := json.Unmarshal(patched.Body.Bytes(), &result); err != nil ||
		result.User.DisplayName != "" || result.User.Username != "reader" || result.User.Locale != "zh" {
		t.Fatalf("patch omitted/empty fields: %s, %v", patched.Body, err)
	}
	duplicate := authRequest(t, router, "PATCH", path, map[string]string{"username": "ADMIN"}, admin)
	if duplicate.Code != 409 {
		t.Fatalf("duplicate username: %d %s", duplicate.Code, duplicate.Body)
	}
	revoke := authRequest(t, router, "POST", path+"/revoke-credentials", map[string]bool{}, admin)
	if revoke.Code != 200 || strings.TrimSpace(revoke.Body.String()) != `{"revoked":true}` {
		t.Fatalf("revoke: %d %s", revoke.Code, revoke.Body)
	}
	reset := authRequest(t, router, "POST", path+"/reset-password", map[string]string{"password": "replacement password"}, admin)
	if reset.Code != 200 || strings.TrimSpace(reset.Body.String()) != `{"reset":true}` {
		t.Fatalf("reset: %d %s", reset.Code, reset.Body)
	}
	deleted := authRequest(t, router, "DELETE", path, nil, admin)
	if deleted.Code != 200 || strings.TrimSpace(deleted.Body.String()) != `{"deleted":true}` {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body)
	}
	for _, endpoint := range []struct {
		method, path string
		body         any
	}{
		{"GET", path, nil}, {"DELETE", path, nil}, {"PATCH", path, map[string]bool{}},
		{"POST", path + "/reset-password", map[string]string{"password": "replacement password"}},
		{"POST", path + "/revoke-credentials", map[string]bool{}},
	} {
		missing := authRequest(t, router, endpoint.method, endpoint.path, endpoint.body, admin)
		if missing.Code != 404 {
			t.Fatalf("missing user: %s %s: %d %s", endpoint.method, endpoint.path, missing.Code, missing.Body)
		}
	}
}

func TestAdminUsersHTTPStrictInputs(t *testing.T) {
	router, _, admin, _ := adminHTTPTest(t)
	for _, test := range []struct {
		method, path, body string
		want               int
	}{
		{"POST", "/api/v1/admin/users", `{"username":"ADMIN","password":"correct horse battery"}`, 409},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"short"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"\u0000","password":"correct horse battery"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"correct horse battery","disabled":true}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"correct horse battery","locale":"fr"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"` + strings.Repeat("x", 65) + `","password":"correct horse battery"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"` + strings.Repeat("x", 1025) + `"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"correct horse battery","display_name":"` + strings.Repeat("x", 129) + `"}`, 400},
		{"POST", "/api/v1/admin/users", `{"username":"new","password":"correct horse battery","display_name":"` + strings.Repeat("x", 16384) + `"}`, 400},
		{"POST", "/api/v1/admin/users", "null", 400},
		{"POST", "/api/v1/admin/users", "[]", 400},
		{"POST", "/api/v1/admin/users", `{} {}`, 400},
		{"PATCH", "/api/v1/admin/users/2", `{"password":"replacement password"}`, 400},
		{"PATCH", "/api/v1/admin/users/2", `{"username":null}`, 400},
		{"PATCH", "/api/v1/admin/users/2", `{"disabled":null}`, 400},
		{"PATCH", "/api/v1/admin/users/2", `{"disabled":"true"}`, 400},
		{"PATCH", "/api/v1/admin/users/2", `{"display_name":"` + string([]byte{0xff}) + `"}`, 400},
		{"PATCH", "/api/v1/admin/users/1", `{"disabled":true}`, 409},
		{"PATCH", "/api/v1/admin/users/1", `{"role":"user"}`, 409},
		{"DELETE", "/api/v1/admin/users/1", "", 409},
		{"GET", "/api/v1/admin/users/0", "", 400},
		{"DELETE", "/api/v1/admin/users/-1", "", 400},
		{"GET", "/api/v1/admin/users/9223372036854775808", "", 400},
		{"GET", "/api/v1/admin/users/abc", "", 400},
		{"GET", "/api/v1/admin/users?limit=0", "", 400},
		{"GET", "/api/v1/admin/users?limit=101", "", 400},
		{"GET", "/api/v1/admin/users?limit=", "", 400},
		{"GET", "/api/v1/admin/users?limit=1&limit=2", "", 400},
		{"GET", "/api/v1/admin/users?role=admin", "", 400},
		{"GET", "/api/v1/admin/users?cursor=invalid", "", 400},
		{"POST", "/api/v1/admin/users/2/reset-password", `{"password":"short"}`, 400},
		{"POST", "/api/v1/admin/users/2/reset-password", `{"password":"replacement password","token":"hidden"}`, 400},
		{"POST", "/api/v1/admin/users/2/revoke-credentials", `{"sessions":true}`, 400},
		{"POST", "/api/v1/admin/users/2/revoke-credentials", `null`, 400},
		{"POST", "/api/v1/admin/users/2/revoke-credentials", ``, 400},
	} {
		request := httptest.NewRequest(test.method, test.path, strings.NewReader(test.body))
		request.AddCookie(admin)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != test.want || !strings.Contains(response.Header().Get("Content-Type"), "application/problem+json") {
			t.Errorf("%s %s body %.80s: %d %s, want %d", test.method, test.path, test.body, response.Code, response.Body, test.want)
		}
	}
}

func TestAdminUsersHTTPSelfCredentialsInvalidateCookie(t *testing.T) {
	for _, operation := range []string{"reset-password", "revoke-credentials"} {
		t.Run(operation, func(t *testing.T) {
			router, _, admin, _ := adminHTTPTest(t)
			body := map[string]string{}
			if operation == "reset-password" {
				body["password"] = "replacement password"
			}
			response := authRequest(t, router, "POST", "/api/v1/admin/users/1/"+operation, body, admin)
			cookies := response.Result().Cookies()
			if response.Code != 200 || len(cookies) != 1 || cookies[0].MaxAge != -1 {
				t.Fatalf("self credentials: %d %s, cookies %+v", response.Code, response.Body, cookies)
			}
			next := authRequest(t, router, "GET", "/api/v1/admin/users", nil, admin)
			if next.Code != 401 {
				t.Fatalf("self session survived: %d %s", next.Code, next.Body)
			}
		})
	}
}
