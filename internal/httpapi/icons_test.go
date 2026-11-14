package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLibraryAndShelfHTTPIconPersistence(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	for _, test := range []struct {
		name, table, envelope, createPath, listPath, updateBase, body string
	}{
		{"library", "libraries", "library", "/api/v1/admin/libraries", "/api/v1/libraries",
			"/api/v1/admin/libraries", `{"name":"Icon library","slug":"icon-library"}`},
		{"shelf", "shelves", "shelf", "/api/v1/shelves", "/api/v1/shelves",
			"/api/v1/shelves", `{"kind":"shared","name":"Icon shelf"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			type entity struct {
				ID   int64   `json:"id"`
				Icon *string `json:"icon"`
			}
			readEntity := func(response *httptest.ResponseRecorder, status int, wantIcon string) entity {
				t.Helper()
				expectShelfStatus(t, response, status)
				var body map[string]entity
				if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
					t.Fatal(err)
				}
				got := body[test.envelope]
				if got.ID == 0 || got.Icon == nil || *got.Icon != wantIcon {
					t.Fatalf("entity = %+v, want icon %q: %s", got, wantIcon, response.Body.String())
				}
				return got
			}
			create := func(body string) *httptest.ResponseRecorder {
				return fixture.request(http.MethodPost, test.createPath, strings.NewReader(body), fixture.admin, nil)
			}
			body := strings.TrimSuffix(test.body, "}") + `,"icon":"book-open"}`
			created := readEntity(create(body), http.StatusCreated, "book-open")
			updatePath := fmt.Sprintf("%s/%d", test.updateBase, created.ID)
			getPath := fmt.Sprintf("%s/%d", test.listPath, created.ID)
			patch := func(body string, cookie *http.Cookie) *httptest.ResponseRecorder {
				return fixture.request(http.MethodPatch, updatePath, strings.NewReader(body), cookie, nil)
			}
			checkStored := func(want string) {
				t.Helper()
				var icon string
				if err := fixture.db.Reader.QueryRow("SELECT icon FROM "+test.table+" WHERE id = ?", created.ID).Scan(&icon); err != nil || icon != want {
					t.Fatalf("persisted icon = %q, %v; want %q", icon, err, want)
				}
				readEntity(fixture.request(http.MethodGet, getPath, nil, fixture.admin, nil), http.StatusOK, want)
				response := fixture.request(http.MethodGet, test.listPath, nil, fixture.admin, nil)
				expectShelfStatus(t, response, http.StatusOK)
				var page struct {
					Items []entity `json:"items"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
					t.Fatal(err)
				}
				for _, item := range page.Items {
					if item.ID == created.ID && item.Icon != nil && *item.Icon == want {
						return
					}
				}
				t.Fatalf("list missing persisted icon %q for %d: %s", want, created.ID, response.Body.String())
			}
			checkStored("book-open")
			readEntity(patch(`{"name":"Renamed icon entity"}`, fixture.admin), http.StatusOK, "book-open")
			checkStored("book-open")
			readEntity(patch(`{"icon":"folder-plus"}`, fixture.admin), http.StatusOK, "folder-plus")
			checkStored("folder-plus")
			expectShelfStatus(t, patch(`{"icon":"star"}`, fixture.other), http.StatusForbidden)
			for _, invalid := range []string{
				`null`, `23`, `"../star"`, `"<svg>"`, `"book open"`, `"Star"`, `"star--filled"`,
				fmt.Sprintf("%q", strings.Repeat("a", 65)),
			} {
				expectShelfStatus(t, patch(`{"icon":`+invalid+`}`, fixture.admin), http.StatusBadRequest)
			}
			checkStored("folder-plus")
			longest := strings.Repeat("a", 64)
			readEntity(patch(fmt.Sprintf(`{"icon":%q}`, longest), fixture.admin), http.StatusOK, longest)
			readEntity(patch(`{"icon":""}`, fixture.admin), http.StatusOK, "")
			checkStored("")
			body = strings.NewReplacer("Icon", "Default", "icon-library", "default-library").Replace(test.body)
			readEntity(create(body), http.StatusCreated, "")
			body = strings.TrimSuffix(strings.NewReplacer("Icon", "Invalid", "icon-library", "invalid-library").Replace(test.body), "}") + `,"icon":"../star"}`
			expectShelfStatus(t, create(body), http.StatusBadRequest)
		})
	}
}

func TestSystemShelfHTTPIconPreservesProtections(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	response := fixture.request(http.MethodGet, "/api/v1/shelves", nil, fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var page struct {
		Items []struct {
			ID        int64   `json:"id"`
			SystemKey *string `json:"system_key"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	for _, shelf := range page.Items {
		if shelf.SystemKey == nil || *shelf.SystemKey != "favorites" {
			continue
		}
		path := shelfHTTPPath(shelf.ID)
		response = fixture.request(http.MethodPatch, path, strings.NewReader(`{"icon":"star"}`), fixture.reader, nil)
		expectShelfStatus(t, response, http.StatusOK)
		var updated struct {
			Shelf struct {
				Icon string `json:"icon"`
			} `json:"shelf"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &updated); err != nil || updated.Shelf.Icon != "star" {
			t.Fatalf("system shelf icon = %+v, %v", updated, err)
		}
		expectShelfStatus(t, fixture.request(http.MethodPatch, path,
			strings.NewReader(`{"name":"Renamed","icon":""}`), fixture.reader, nil), http.StatusConflict)
		expectShelfStatus(t, fixture.request(http.MethodPatch, path,
			strings.NewReader(`{"icon":"bookmark"}`), fixture.other, nil), http.StatusNotFound)
		return
	}
	t.Fatal("favorites system shelf is missing")
}
