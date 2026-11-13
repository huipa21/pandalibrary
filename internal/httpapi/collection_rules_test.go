package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"pandalibrary/internal/catalog"
)

func TestCollectionHTTPGroupsAndManualProvenance(t *testing.T) {
	fixture := newShelfHTTPFixture(t)
	groups := `[{"id":"visible","name":"Visible books","rules":{"match":"all","conditions":[{"field":"author_id","op":"eq","value":1}]}},{"id":"secret","name":"Other library","rules":{"match":"any","conditions":[{"field":"title","op":"contains","value":"Secret"}]}}]`
	response := fixture.request(http.MethodPost, "/api/v1/shelves", strings.NewReader(
		`{"kind":"shared","name":"Collection","rule_groups":`+groups+`}`), fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusCreated)
	var result struct {
		Shelf catalog.Shelf `json:"shelf"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || len(result.Shelf.RuleGroups) != 2 || result.Shelf.VisibleBookCount != 2 {
		t.Fatalf("collection create = %s, %v", response.Body.String(), err)
	}
	id := result.Shelf.ID
	response = fixture.request(http.MethodGet, shelfHTTPPath(id)+"/books", nil, fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	var page catalog.Page[catalog.Book]
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || len(page.Items) != 1 || page.Items[0].ID != 101 {
		t.Fatalf("reader shared collection = %s, %v", response.Body.String(), err)
	}
	expectShelfStatus(t, fixture.request(http.MethodPatch, shelfHTTPPath(id),
		strings.NewReader(`{"rule_groups":[],"remove_rule_books":true}`), fixture.reader, nil), http.StatusForbidden)
	expectShelfStatus(t, fixture.request(http.MethodPut, shelfHTTPBookPath(id, 101), nil, fixture.admin, nil), http.StatusOK)
	response = fixture.request(http.MethodPatch, shelfHTTPPath(id),
		strings.NewReader(`{"rule_groups":[],"remove_rule_books":true}`), fixture.admin, nil)
	expectShelfStatus(t, response, http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || len(result.Shelf.RuleGroups) != 0 || result.Shelf.VisibleBookCount != 1 {
		t.Fatalf("manual membership survives group removal = %s, %v", response.Body.String(), err)
	}
	expectShelfStatus(t, fixture.request(http.MethodDelete, shelfHTTPBookPath(id, 101), nil, fixture.admin, nil), http.StatusOK)

	response = fixture.request(http.MethodPost, "/api/v1/shelves", strings.NewReader(
		`{"kind":"private","name":"Retain","rule_groups":`+groups+`}`), fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusCreated)
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	id = result.Shelf.ID
	response = fixture.request(http.MethodPatch, shelfHTTPPath(id), strings.NewReader(`{"rule_groups":[]}`), fixture.reader, nil)
	expectShelfStatus(t, response, http.StatusOK)
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Shelf.VisibleBookCount != 1 {
		t.Fatalf("safe default retains current matches = %s, %v", response.Body.String(), err)
	}
	for _, body := range []string{
		`{"rule_groups":null}`,
		`{"rule_groups":[{"id":"x","name":"Name","rules":{"match":"all","conditions":[{"field":"title","op":"contains","value":"Visible"}]},"unknown":true}]}`,
		`{"rule_groups":[],"remove_rule_books":"true"}`,
		`{"rule_groups":[],"rules":{"match":"all","conditions":[{"field":"title","op":"contains","value":"Visible"}]}}`,
	} {
		expectShelfStatus(t, fixture.request(http.MethodPatch, shelfHTTPPath(id), strings.NewReader(body), fixture.reader, nil), http.StatusBadRequest)
	}
}
