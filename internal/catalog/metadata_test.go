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

func TestApplyMetadataExtendedFieldsRecordProvenance(t *testing.T) {
	f := newCatalogFixture(t)
	ctx := context.Background()
	admin := Viewer{UserID: 1, IsAdmin: true}
	if _, err := f.service.UpdateBook(ctx, admin, 101, bookPatch(t, `{"ratings":[{"provider":"neodb","rating":3,"count":2}]}`)); err != nil {
		t.Fatal(err)
	}
	trusted := MetadataSource{Provider: "hardcover", Reference: "book-1"}
	sources := map[string]MetadataSource{}
	for _, field := range []string{"genres", "moods", "age_rating", "content_rating", "ratings", "series"} {
		sources[field] = trusted
	}
	book, err := f.service.ApplyMetadataWithPatch(ctx, admin, 101, bookPatch(t, `{
		"genres":["Fantasy"], "moods":["Hopeful"], "age_rating":16, "content_rating":"mature",
		"ratings":[{"provider":"hardcover","rating":4.5,"count":100}], "series":{"name":"Saga","index":1,"total":3}
	}`), sources, nil, bookPatch(t, `{"description":"Manual"}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(book.Ratings) != 2 || book.Ratings[0].Provider != "hardcover" || *book.Ratings[0].Rating != 4.5 ||
		book.Ratings[1].Provider != "neodb" || *book.Ratings[1].Rating != 3 {
		t.Fatalf("provider ratings should upsert only the selected provider: %+v", book.Ratings)
	}
	if book.Series == nil || book.Series.Total == nil || *book.Series.Total != 3 || *book.AgeRating != 16 ||
		*book.ContentRating != "mature" || book.Genres[0] != "Fantasy" || book.Moods[0] != "Hopeful" {
		t.Fatalf("applied metadata = %+v", book)
	}
	got := map[string]string{}
	for _, source := range book.FieldSources {
		ref := ""
		if source.SourceRef != nil {
			ref = *source.SourceRef
		}
		got[source.Field] = source.Source + "|" + ref
	}
	for field := range sources {
		if got[field] != "hardcover|book-1" {
			t.Errorf("source for %s = %q", field, got[field])
		}
	}
	if got["description"] != "manual|" {
		t.Errorf("manual description source = %q", got["description"])
	}
}
