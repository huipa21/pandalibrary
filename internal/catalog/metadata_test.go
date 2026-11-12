package catalog

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestApplyMetadataRequiresTrustedProvenance(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	before, err := f.service.GetBook(ctx, admin, 101)
	if err != nil {
		t.Fatal(err)
	}
	trusted := MetadataSource{Provider: "openlibrary", Reference: "/works/OL123W"}
	for _, test := range []struct {
		name    string
		patch   string
		sources map[string]MetadataSource
	}{
		{"nil", `{"title":"Provider title"}`, nil},
		{"missing", `{"title":"Provider title","subtitle":"Provider subtitle"}`, map[string]MetadataSource{"title": trusted}},
		{"extra", `{"title":"Provider title"}`, map[string]MetadataSource{"title": trusted, "subtitle": trusted}},
		{"wrong field", `{"title":"Provider title"}`, map[string]MetadataSource{"subtitle": trusted}},
		{"manual source", `{"title":"Provider title"}`, map[string]MetadataSource{"title": {Provider: "manual", Reference: "forged"}}},
		{"empty reference", `{"title":"Provider title"}`, map[string]MetadataSource{"title": {Provider: "openlibrary"}}},
		{"library move", `{"library_id":10,"title":"Provider title"}`, map[string]MetadataSource{"title": trusted}},
		{"empty provider patch", `{}`, map[string]MetadataSource{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			patch := bookPatch(t, test.patch)
			if _, err := f.service.ApplyMetadata(ctx, admin, 101, patch, test.sources, nil); !errors.Is(err, ErrInvalid) {
				t.Fatalf("provider-only error = %v", err)
			}
			if _, err := f.service.ApplyMetadataWithPatch(ctx, admin, 101, patch, test.sources, nil,
				bookPatch(t, `{"description":"Manual description"}`)); !errors.Is(err, ErrInvalid) {
				t.Fatalf("mixed error = %v", err)
			}
			after, err := f.service.GetBook(ctx, admin, 101)
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("invalid provenance mutated book: %+v, %v", after, err)
			}
		})
	}
}
