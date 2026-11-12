package httpapi

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"

	"pandalibrary/internal/auth"
)

func TestAdminUsersHTTPSearchAndCursorScope(t *testing.T) {
	router, service, admin, _ := adminHTTPTest(t)
	for _, input := range []auth.CreateUserInput{
		{Username: "match-one", DisplayName: "Other", Locale: "en", Role: "user", Password: "correct horse battery"},
		{Username: "match-two", DisplayName: "Target Person", Locale: "zh", Role: "user", Password: "correct horse battery"},
	} {
		if _, err := service.CreateUser(t.Context(), input); err != nil {
			t.Fatal(err)
		}
	}
	first := authRequest(t, router, "GET", "/api/v1/admin/users?limit=1&q=MATCH&category=username", nil, admin)
	var page auth.AdminUsersPage
	if err := json.Unmarshal(first.Body.Bytes(), &page); err != nil || first.Code != 200 ||
		len(page.Items) != 1 || page.Items[0].Username != "match-one" || page.NextCursor == nil {
		t.Fatalf("search first page: %d %s, %v", first.Code, first.Body, err)
	}
	second := authRequest(t, router, "GET", "/api/v1/admin/users?limit=1&q=MATCH&category=username&cursor="+url.QueryEscape(*page.NextCursor), nil, admin)
	var next auth.AdminUsersPage
	if err := json.Unmarshal(second.Body.Bytes(), &next); err != nil || len(next.Items) != 1 || next.Items[0].Username != "match-two" || next.NextCursor != nil {
		t.Fatalf("search second page: %d %s, %v", second.Code, second.Body, err)
	}
	for _, query := range []string{
		"q=other&category=username&cursor=" + url.QueryEscape(*page.NextCursor),
		"q=MATCH&category=display_name&cursor=" + url.QueryEscape(*page.NextCursor),
		"category=invalid", "q=one&q=two", "q=" + strings.Repeat("x", 257),
	} {
		response := authRequest(t, router, "GET", "/api/v1/admin/users?"+query, nil, admin)
		if response.Code != 400 {
			t.Fatalf("invalid search %q: %d %s", query, response.Code, response.Body)
		}
	}
	for _, query := range []string{"q=target&category=display_name", "q=zh&category=locale", "q=TARGET", "q=match-two&category=username"} {
		response := authRequest(t, router, "GET", "/api/v1/admin/users?"+query, nil, admin)
		var result auth.AdminUsersPage
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || response.Code != 200 ||
			len(result.Items) != 1 || result.Items[0].Username != "match-two" {
			t.Fatalf("search %q: %d %s, %v", query, response.Code, response.Body, err)
		}
	}
	literal := authRequest(t, router, "GET", "/api/v1/admin/users?q=%25&category=username", nil, admin)
	var empty auth.AdminUsersPage
	if err := json.Unmarshal(literal.Body.Bytes(), &empty); err != nil || literal.Code != 200 || len(empty.Items) != 0 {
		t.Fatalf("literal wildcard search: %d %s, %v", literal.Code, literal.Body, err)
	}
}
