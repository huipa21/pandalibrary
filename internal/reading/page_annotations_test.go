package reading

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const pageLocator = `{"type":"pdf","page":1,"rect":{"x":0.1,"y":0.2,"width":0.3,"height":0.4}}`

func TestCFIPageAnnotationsPersistAndValidateAnchors(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	locator := `{"type":"cfi","value":"epubcfi(/6/2!/4/2:5)","rect":{"x":0.1,"y":0,"width":0.3,"height":0.2}}`
	id := "018f0f7e-7b00-7000-8000-000000000001"
	payload := pagePayload(101, "201", "text", locator, `{"text":"Anchored text","color":"#000000","size":0.02}`, 0.3)
	response, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("page_annotations", id, "", "upsert", payload, 1000),
	}})
	if err != nil || response.Results[0].Status != "applied" {
		t.Fatalf("CFI insert = %+v, %v", response, err)
	}
	state, err := fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.PageAnnotations) != 1 || string(state.PageAnnotations[0].Locator) != locator {
		t.Fatalf("reopened CFI annotation = %+v, %v", state.PageAnnotations, err)
	}
	pull, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil || len(pull.PageAnnotations) != 1 || string(pull.PageAnnotations[0].Locator) != locator {
		t.Fatalf("synced CFI annotation = %+v, %v", pull.PageAnnotations, err)
	}
	for _, invalid := range []string{
		strings.Replace(locator, `"value":`, `"page":1,"value":`, 1),
		strings.Replace(locator, `epubcfi(/6/2!/4/2:5)`, `chapter.xhtml`, 1),
		strings.Replace(locator, `epubcfi(/6/2!/4/2:5)`, `epubcfi(unclosed`, 1),
		strings.Replace(locator, `"x":0.1`, `"x":0.9`, 1),
		strings.Replace(locator, `"value":`, `"extra":1,"value":`, 1),
	} {
		if validPageAnnotationLocator(json.RawMessage(invalid)) {
			t.Errorf("accepted invalid CFI locator: %s", invalid)
		}
	}
}

func pagePayload(bookID int, fileID string, kind, locator, content string, position float64) string {
	return fmt.Sprintf(`{"book_id":%d,"book_file_id":%s,"kind":%q,"locator":%s,"position":%v,"data":%s}`,
		bookID, fileID, kind, locator, position, content)
}

func TestHighlightStylesAndLegacyUpdates(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	id := "018f0f7e-7b00-7000-8000-000000000001"
	base := `"book_id":101,"book_file_id":201,"locator":{"type":"cfi","value":"epubcfi(/6/2)"},"position":0.5,"text":"text","color":"yellow"`
	push := func(data string, at int64, want string) {
		t.Helper()
		result, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
			mutation("highlights", id, "", "upsert", "{"+base+data+"}", at),
		}})
		if err != nil || result.Results[0].Status != want {
			t.Fatalf("push style %s = %+v, %v; want %s", data, result, err, want)
		}
	}
	check := func(want string) {
		t.Helper()
		state, err := fixture.service.GetBookState(ctx, viewer, 101)
		if err != nil || len(state.Highlights) != 1 || state.Highlights[0].Style != want {
			t.Fatalf("highlight style = %+v, %v; want %q", state.Highlights, err, want)
		}
		pull, err := fixture.service.Pull(ctx, viewer, 0)
		if err != nil || len(pull.Highlights) != 1 || pull.Highlights[0].Style != want {
			t.Fatalf("pulled style = %+v, %v; want %q", pull.Highlights, err, want)
		}
	}
	push("", 1000, "applied")
	check("highlight")
	noteID := "018f0f7e-7b00-7000-8000-000000000002"
	note, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("notes", noteID, "", "upsert",
			`{"book_id":101,"highlight_id":"018f0f7e-7b00-7000-8000-000000000001","body_md":"companion note"}`, 1001),
	}})
	if err != nil || note.Results[0].Status != "applied" {
		t.Fatalf("create attached note = %+v, %v", note, err)
	}
	push(`,"style":"underline"`, 1100, "applied")
	check("underline")
	push("", 1200, "applied")
	check("underline")
	push(`,"style":"strikeout"`, 1300, "applied")
	check("strikeout")
	push(`,"style":"highlight"`, 1400, "applied")
	check("highlight")
	push(`,"style":"underline"`, 1350, "stale")
	push(`,"style":"unknown"`, 1500, "rejected")
	check("highlight")
	search, err := fixture.service.SearchAnnotations(ctx, viewer, "text", "")
	if err != nil || len(search) != 2 {
		t.Fatalf("highlight search after style updates = %+v, %v", search, err)
	}
	search, err = fixture.service.SearchAnnotations(ctx, viewer, "companion", "")
	if err != nil || len(search) != 1 || search[0].ID != noteID {
		t.Fatalf("attached note search after style updates = %+v, %v", search, err)
	}
	result, err := fixture.service.Push(ctx, viewer, PushRequest{Mutations: []Mutation{
		mutation("highlights", id, "", "delete", `{}`, 1600),
	}})
	if err != nil || result.Results[0].Status != "applied" {
		t.Fatalf("delete highlight = %+v, %v", result, err)
	}
	pull, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil || len(pull.Highlights) != 1 || pull.Highlights[0].Style != "highlight" || pull.Highlights[0].DeletedAt == nil {
		t.Fatalf("highlight tombstone = %+v, %v", pull.Highlights, err)
	}
}

func TestPageAnnotationsSyncOwnershipAssetsAndTombstones(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	viewer := Viewer{UserID: 2}
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
		VALUES (202, 101, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pdf', 1, 'book.pdf', 1)
	`); err != nil {
		t.Fatal(err)
	}
	id := "018f0f7e-7b00-7000-8000-000000000001"
	imageID := "018f0f7e-7b00-7000-8000-000000000002"
	unavailableID := "018f0f7e-7b00-7000-8000-000000000003"
	text := pagePayload(101, "202", "text", pageLocator, `{"text":"Hello","color":"#123abc","size":0.02}`, 0.4)
	edit := pagePayload(101, "null", "text", pageLocator, `{"text":"Updated","color":"#123abc","size":0.08}`, 0.5)
	ink := pagePayload(101, "202", "ink", pageLocator, `{"color":"#123abc","width":0.01,"strokes":[[0,0,1,1]]}`, 0.4)
	push := func(user Viewer, item Mutation, want string) MutationResult {
		t.Helper()
		response, err := fixture.service.Push(ctx, user, PushRequest{Mutations: []Mutation{item}})
		if err != nil || len(response.Results) != 1 || response.Results[0].Status != want {
			t.Fatalf("push %s = %+v, %v; want %s", item.Entity, response, err, want)
		}
		return response.Results[0]
	}
	push(viewer, mutation("page_annotations", id, "", "upsert", text, 1000), "applied")
	initial, err := fixture.service.Pull(ctx, viewer, 0)
	if err != nil || len(initial.PageAnnotations) != 1 || initial.PageAnnotations[0].Kind != "text" {
		t.Fatalf("initial pull = %+v, %v", initial.PageAnnotations, err)
	}
	push(viewer, mutation("page_annotations", id, "", "upsert", text, 1000), "stale")
	if result := push(viewer, mutation("page_annotations", id, "", "upsert", ink, 1100), "rejected"); result.Reason != "page annotation kind cannot change" {
		t.Fatalf("kind change reason = %q", result.Reason)
	}
	moved := pagePayload(102, "null", "text", pageLocator, `{"text":"Moved","color":"#000000","size":0.02}`, 0)
	if result := push(viewer, mutation("page_annotations", id, "", "upsert", moved, 1100), "rejected"); result.Reason != "page annotation cannot be moved to another book" {
		t.Fatalf("book change reason = %q", result.Reason)
	}
	push(Viewer{UserID: 1, IsAdmin: true}, mutation("page_annotations", id, "", "upsert", text, 1100), "rejected")
	push(viewer, mutation("page_annotations", id, "", "upsert", edit, 1200), "applied")
	push(viewer, mutation("page_annotations", id, "", "upsert", text, 1100), "stale")
	state, err := fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.PageAnnotations) != 1 || state.PageAnnotations[0].BookFileID != nil ||
		!strings.Contains(string(state.PageAnnotations[0].Data), `"Updated"`) {
		t.Fatalf("edited book state = %+v, %v", state.PageAnnotations, err)
	}
	for _, invalid := range []string{
		pagePayload(102, "null", "text", pageLocator, `{"text":"Hidden","color":"#000000","size":0.02}`, 0),
		pagePayload(103, "null", "text", pageLocator, `{"text":"Private","color":"#000000","size":0.02}`, 0),
		pagePayload(101, "999", "text", pageLocator, `{"text":"Bad file","color":"#000000","size":0.02}`, 0),
	} {
		push(viewer, mutation("page_annotations", unavailableID, "", "upsert", invalid, 1300), "rejected")
	}

	hash := strings.Repeat("a", 64)
	image := pagePayload(101, "202", "image", pageLocator,
		fmt.Sprintf(`{"asset":%q,"media_type":"image/png","width":1,"height":8192}`, hash), 1)
	if _, err := fixture.db.Writer.ExecContext(ctx,
		`INSERT INTO annotation_assets (user_id, sha256, media_type, size, width, height, created_at)
		 VALUES (3, ?, 'image/png', 1, 1, 8192, 1)`, hash); err != nil {
		t.Fatal(err)
	}
	result := push(viewer, mutation("page_annotations", imageID, "", "upsert", image, 1300), "rejected")
	if result.Reason != "annotation asset is unavailable" {
		t.Fatalf("foreign asset reason = %q", result.Reason)
	}
	if _, err := fixture.db.Writer.ExecContext(ctx,
		`INSERT INTO annotation_assets (user_id, sha256, media_type, size, width, height, created_at)
		 VALUES (2, ?, 'image/png', 1, 1, 8192, 1)`, hash); err != nil {
		t.Fatal(err)
	}
	push(viewer, mutation("page_annotations", imageID, "", "upsert", image, 1400), "applied")
	var storedHash string
	if err := fixture.db.Reader.QueryRowContext(ctx,
		`SELECT asset_sha256 FROM page_annotations WHERE id = ?`, imageID).Scan(&storedHash); err != nil || storedHash != hash {
		t.Fatalf("stored image hash = %q, %v", storedHash, err)
	}

	push(viewer, mutation("page_annotations", id, "", "delete", `{}`, 1100), "stale")
	push(viewer, mutation("page_annotations", id, "", "delete", `{}`, 1500), "applied")
	push(viewer, mutation("page_annotations", id, "", "delete", `{}`, 1600), "stale")
	after, err := fixture.service.Pull(ctx, viewer, initial.Cursor)
	if err != nil || len(after.PageAnnotations) != 2 {
		t.Fatalf("incremental pull = %+v, %v", after.PageAnnotations, err)
	}
	var tombstone *PageAnnotation
	for i := range after.PageAnnotations {
		if after.PageAnnotations[i].ID == id {
			tombstone = &after.PageAnnotations[i]
		}
	}
	if tombstone == nil || tombstone.DeletedAt == nil || tombstone.Rev <= initial.PageAnnotations[0].Rev {
		t.Fatalf("tombstone = %+v", tombstone)
	}
	state, err = fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.PageAnnotations) != 1 || state.PageAnnotations[0].ID != imageID {
		t.Fatalf("live book state = %+v, %v", state.PageAnnotations, err)
	}
	push(viewer, mutation("page_annotations", id, "", "upsert", text, 1400), "stale")
	push(viewer, mutation("page_annotations", id, "", "upsert", ink, 1700), "rejected")
	push(viewer, mutation("page_annotations", id, "", "upsert", edit, 1700), "applied")
	state, err = fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.PageAnnotations) != 2 || state.PageAnnotations[0].CreatedAt != initial.PageAnnotations[0].CreatedAt {
		t.Fatalf("resurrected state = %+v, %v", state.PageAnnotations, err)
	}

	if _, err := fixture.db.Writer.ExecContext(ctx, `DELETE FROM book_files WHERE id = 202`); err != nil {
		t.Fatal(err)
	}
	state, err = fixture.service.GetBookState(ctx, viewer, 101)
	if err != nil || len(state.PageAnnotations) != 2 || state.PageAnnotations[1].BookFileID != nil {
		t.Fatalf("deleted file reference = %+v, %v", state.PageAnnotations, err)
	}
}

func TestPageAnnotationValidationBoundaries(t *testing.T) {
	ink := func(points int) string {
		return `{"color":"#abcdef","width":0.001,"strokes":[[` +
			strings.Repeat("0,0,", points-1) + `0,0]]}`
	}
	strokes := func(count int) string {
		return `{"color":"#abcdef","width":0.02,"strokes":[` +
			strings.Repeat("[0,0],", count-1) + `[0,0]]}`
	}
	padded := func(size int) string {
		const prefix = `{"text":"x","color":"#000000","size":0.008`
		return prefix + strings.Repeat(" ", size-len(prefix)-1) + `}`
	}
	image := func(hash, media string, width, height int) string {
		return fmt.Sprintf(`{"asset":%q,"media_type":%q,"width":%d,"height":%d}`, hash, media, width, height)
	}
	tests := []struct {
		name, kind, data string
		valid            bool
	}{
		{"text minimum", "text", `{"text":"x","color":"#000000","size":0.008}`, true},
		{"text maximum code points", "text", `{"text":"` + strings.Repeat("😀", 4000) + `","color":"#abcdef","size":0.08}`, true},
		{"text too long", "text", `{"text":"` + strings.Repeat("😀", 4001) + `","color":"#abcdef","size":0.08}`, false},
		{"empty text", "text", `{"text":"","color":"#abcdef","size":0.02}`, false},
		{"nul text", "text", `{"text":"a\u0000b","color":"#abcdef","size":0.02}`, false},
		{"uppercase color", "text", `{"text":"x","color":"#ABCDEF","size":0.02}`, false},
		{"small text", "text", `{"text":"x","color":"#abcdef","size":0.007999}`, false},
		{"large text", "text", `{"text":"x","color":"#abcdef","size":0.080001}`, false},
		{"maximum data bytes", "text", padded(65536), true},
		{"too many data bytes", "text", padded(65537), false},
		{"maximum points", "ink", ink(10000), true},
		{"too many points", "ink", ink(10001), false},
		{"maximum strokes", "ink", strokes(200), true},
		{"too many strokes", "ink", strokes(201), false},
		{"empty strokes", "ink", `{"color":"#abcdef","width":0.01,"strokes":[]}`, false},
		{"odd stroke", "ink", `{"color":"#abcdef","width":0.01,"strokes":[[0,0,1]]}`, false},
		{"null coordinate", "ink", `{"color":"#abcdef","width":0.01,"strokes":[[null,0]]}`, false},
		{"invalid coordinate", "ink", `{"color":"#abcdef","width":0.01,"strokes":[[0,1.001]]}`, false},
		{"small width", "ink", `{"color":"#abcdef","width":0.0009,"strokes":[[0,0]]}`, false},
		{"large width", "ink", `{"color":"#abcdef","width":0.0201,"strokes":[[0,0]]}`, false},
		{"image dimensions", "image", image(strings.Repeat("a", 64), "image/webp", 1, 8192), true},
		{"image uppercase hash", "image", image(strings.Repeat("A", 64), "image/webp", 1, 1), false},
		{"image media", "image", image(strings.Repeat("a", 64), "image/gif", 1, 1), false},
		{"image zero dimension", "image", image(strings.Repeat("a", 64), "image/jpeg", 0, 1), false},
		{"image dimension too large", "image", image(strings.Repeat("a", 64), "image/png", 1, 8193), false},
		{"unknown fields", "text", `{"text":"x","color":"#000000","size":0.02,"extra":true}`, false},
		{"unknown kind", "other", `{}`, false},
		{"non-object data", "text", `null`, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, valid := validPageAnnotationData(test.kind, json.RawMessage(test.data))
			if valid != test.valid {
				t.Fatalf("validPageAnnotationData = %v, want %v", valid, test.valid)
			}
		})
	}
	const locatorPrefix = `{"type":"pdf","page":1,"rect":{"x":0,"y":0,"width":1,"height":1}`
	locatorOfSize := func(size int) json.RawMessage {
		return json.RawMessage(locatorPrefix + strings.Repeat(" ", size-len(locatorPrefix)-1) + `}`)
	}
	for _, test := range []struct {
		locator json.RawMessage
		valid   bool
	}{
		{json.RawMessage(pageLocator), true},
		{locatorOfSize(16384), true},
		{locatorOfSize(16385), false},
		{json.RawMessage(`{"type":"pdf","page":0,"rect":{"x":0,"y":0,"width":1,"height":1}}`), false},
		{json.RawMessage(`{"type":"pdf","page":1,"rect":{"x":0.9,"y":0,"width":0.2,"height":1}}`), false},
		{json.RawMessage(`{"type":"pdf","page":1,"rect":{"x":0,"y":0,"width":0,"height":1}}`), false},
		{json.RawMessage(`{"type":"pdf","page":1,"rect":{"x":null,"y":0,"width":1,"height":1}}`), false},
	} {
		if valid := validPageAnnotationLocator(test.locator); valid != test.valid {
			t.Errorf("locator valid = %v, want %v", valid, test.valid)
		}
	}

	fixture := newReadingFixture(t)
	ctx := context.Background()
	for index, test := range []struct {
		content, want string
	}{
		{padded(65536), "applied"}, {padded(65537), "rejected"},
		{ink(10000), "applied"}, {ink(10001), "rejected"},
	} {
		kind := "text"
		if index >= 2 {
			kind = "ink"
		}
		data := pagePayload(101, "null", kind, pageLocator, test.content, 0)
		id := fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", index+1)
		response, err := fixture.service.Push(ctx, Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
			mutation("page_annotations", id, "", "upsert", data, 1000),
		}})
		if err != nil || response.Results[0].Status != test.want {
			t.Fatalf("push boundary %d = %+v, %v; want %s", index, response, err, test.want)
		}
	}
	for index, test := range []struct {
		locator json.RawMessage
		want    string
	}{
		{locatorOfSize(16384), "applied"}, {locatorOfSize(16385), "rejected"},
	} {
		data := pagePayload(101, "null", "text", string(test.locator),
			`{"text":"x","color":"#000000","size":0.02}`, 0)
		id := fmt.Sprintf("018f0f7e-7b00-7000-8000-%012d", index+10)
		response, err := fixture.service.Push(ctx, Viewer{UserID: 2}, PushRequest{Mutations: []Mutation{
			mutation("page_annotations", id, "", "upsert", data, 1000),
		}})
		if err != nil || response.Results[0].Status != test.want {
			t.Fatalf("push locator boundary %d = %+v, %v; want %s", index, response, err, test.want)
		}
	}
}

func TestPageAnnotationJSONRemainsCompatibleWithOlderClients(t *testing.T) {
	fixture := newReadingFixture(t)
	ctx := context.Background()
	pull, err := fixture.service.Pull(ctx, Viewer{UserID: 2}, 0)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(pull)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"page_annotations":[]`) {
		t.Fatalf("empty collection missing from pull: %s", raw)
	}
	var oldClient struct {
		Cursor     int64       `json:"cursor"`
		Highlights []Highlight `json:"highlights"`
		Bookmarks  []Bookmark  `json:"bookmarks"`
	}
	if err := json.Unmarshal(raw, &oldClient); err != nil || oldClient.Highlights == nil || oldClient.Bookmarks == nil {
		t.Fatalf("old client cannot read pull: %+v, %v", oldClient, err)
	}
	state, err := fixture.service.GetBookState(ctx, Viewer{UserID: 2}, 101)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = json.Marshal(state)
	if err != nil || !strings.Contains(string(raw), `"page_annotations":[]`) {
		t.Fatalf("empty book state shape = %s, %v", raw, err)
	}
}
