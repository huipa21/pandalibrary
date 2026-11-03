package opds

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/httpapi"
	"pandalibrary/internal/search"
)

var fixedNow = time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)

type fixture struct {
	t         *testing.T
	database  *db.DB
	handler   http.Handler
	secrets   map[string]string
	kosync    string
	epubBytes []byte
	coverFull []byte
}

type fixtureOptions struct {
	baseURL string
}

func newFixture(t *testing.T, options fixtureOptions) *fixture {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, "pandalibrary.db")
	database, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := database.Close(); err != nil {
			t.Errorf("close test database: %v", err)
		}
	})
	runner, err := migrations.NewRunner(database.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	blobs, err := blobstore.New(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{t: t, database: database, secrets: map[string]string{}}
	f.epubBytes = []byte("PK\x03\x04 fake epub payload")
	epubHash := f.publishBook(ctx, blobs, f.epubBytes, "epub")
	hiddenHash := f.publishBook(ctx, blobs, []byte("PK\x03\x04 hidden payload"), "epub")
	pdfHash := f.publishBook(ctx, blobs, []byte("%PDF-1.7 fake"), "pdf")
	f.coverFull = []byte("\xff\xd8\xff full cover")
	coverSum := sha256.Sum256(f.coverFull)
	coverHash := hex.EncodeToString(coverSum[:])
	if err := blobs.PublishCover(coverHash, f.coverFull, []byte("\xff\xd8\xff thumbnail")); err != nil {
		t.Fatal(err)
	}

	f.exec(`INSERT INTO users (id, username, password_hash, role, disabled, created_at, updated_at) VALUES
		(1, 'reader', 'x', 'user', 0, 1, 1), (2, 'admin', 'x', 'admin', 0, 1, 1),
		(3, 'other', 'x', 'user', 0, 1, 1), (4, 'disabled', 'x', 'user', 1, 1, 1)`)
	f.exec(`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
		(10, 'Main & <Co>', 'main', 1, 1), (20, 'Private', 'private', 1, 1)`)
	f.exec(`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 1, 1), (10, 3, 1), (10, 4, 1)`)
	f.exec(`INSERT INTO series (id, name, created_at) VALUES (1, 'Saga', 1)`)
	f.exec(`INSERT INTO authors (id, name, sort_name, created_at) VALUES
		(1, 'Ann Author', 'author, ann', 1), (2, 'Tran Slator', 'slator, tran', 1), (3, 'Hidden Author', 'author, hidden', 1)`)
	f.exec(`INSERT INTO tags (id, name, created_at) VALUES (1, 'Fantasy', 1), (2, 'Secret', 1)`)
	f.exec(`INSERT INTO books (id, library_id, title, sort_title, subtitle, description, language,
		publisher, published_date, series_id, series_index, cover_sha256, cover_source, created_at, updated_at)
		VALUES (101, 10, ?, 'panda', 'A <Tale>', '<b>Bold</b> & more', 'en', 'Pub & Co', '2020-01-02',
		1, 2, ?, 'upload', 5000, 6000)`, "Panda & <Friends> \"One\"\x01", coverHash)
	f.exec(`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
		(102, 10, 'Hidden Panda', 'hidden panda', 4000, 4000),
		(103, 20, 'Private Panda', 'private panda', 4001, 4001),
		(104, 10, 'Admin Hidden Panda', 'admin hidden panda', 4002, 4002)`)
	for i := 1; i <= 60; i++ {
		f.exec(`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at)
			VALUES (?, 10, ?, ?, ?, ?)`, 1000+i, fmt.Sprintf("Filler %02d", i), fmt.Sprintf("filler %02d", i), 100+i, 100+i)
	}
	f.exec(`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
		(101, 1, 'author', 0), (101, 2, 'translator', 1), (102, 3, 'author', 0)`)
	f.exec(`INSERT INTO book_tags (book_id, tag_id) VALUES (101, 1), (102, 2)`)
	f.exec(`INSERT INTO book_identifiers (book_id, scheme, value) VALUES (101, 'isbn13', '9780000000002')`)
	f.exec(`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at) VALUES
		(201, 101, ?, 'epub', ?, 'dir/panda.epub', 1), (202, 101, ?, 'pdf', 13, 'panda.pdf', 1),
		(203, 102, ?, 'epub', 22, 'hidden.epub', 1)`, epubHash, len(f.epubBytes), pdfHash, hiddenHash)
	f.exec(`INSERT INTO books (id, library_id, title, sort_title, created_at, updated_at) VALUES
		(105, 10, 'Metadata Only', 'metadata only', 50, 50)`)
	f.exec(`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at) VALUES
		(204, 103, ?, 'epub', 10, 'private.epub', 1), (205, 104, ?, 'epub', 10, 'admin.epub', 1)`,
		fmt.Sprintf("%064x", 1), fmt.Sprintf("%064x", 2))
	for i := 1; i <= 60; i++ {
		f.exec(`INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (?, ?, ?, 'epub', 10, 'filler.epub', 1)`, 3000+i, 1000+i, fmt.Sprintf("%064x", 100+i))
	}
	f.exec(`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (1, 102, 2, 1), (2, 104, 2, 1)`)
	f.exec(`INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES
		(1, 101, 'reading', 10, 1), (1, 102, 'reading', 11, 2), (1, 103, 'reading', 12, 3),
		(2, 104, 'reading', 13, 4), (3, 1001, 'reading', 14, 5)`)
	for i := 1; i <= 55; i++ {
		f.exec(`INSERT INTO user_books (user_id, book_id, status, updated_at, rev) VALUES (1, ?, 'want_to_read', ?, ?)`,
			1000+i, 100+i%7, 100+i)
	}
	f.exec(`INSERT INTO shelves (id, kind, owner_id, name, created_by, created_at, updated_at) VALUES
		(1, 'private', 1, 'Mine', 1, 1, 1), (2, 'private', 3, 'Theirs', 3, 1, 1), (3, 'shared', NULL, 'Shared', 2, 1, 1)`)
	f.exec(`INSERT INTO shelf_books (shelf_id, book_id, position, added_at) VALUES
		(1, 102, 0, 1), (1, 101, 1, 1), (2, 1001, 0, 1), (3, 103, 0, 1), (3, 1002, 1, 1)`)
	if err := db.WithTx(ctx, database.Writer, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id FROM books`)
		if err != nil {
			return err
		}
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		for _, id := range ids {
			if err := search.IndexBook(ctx, tx, id); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	authentication, err := auth.NewService(ctx, database.Writer, database.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	for id, name := range map[int64]string{1: "reader", 2: "admin", 3: "other", 4: "disabled"} {
		password, err := authentication.CreateAppPassword(ctx, id, "opds", "e-reader")
		if err != nil {
			t.Fatal(err)
		}
		f.secrets[name] = password.Secret
	}
	kosyncPassword, err := authentication.CreateAppPassword(ctx, 1, "kosync", "KOReader")
	if err != nil {
		t.Fatal(err)
	}
	f.kosync = kosyncPassword.Secret
	catalogService, err := catalog.NewService(database.Writer, database.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	searchService, err := search.NewService(database.Reader)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	var base *url.URL
	if options.baseURL != "" {
		if base, err = url.Parse(options.baseURL); err != nil {
			t.Fatal(err)
		}
	}
	mount, err := NewMount(Options{
		Catalog: catalogService, Search: searchService, Auth: authentication, Reader: database.Reader,
		BaseURL: base, Logger: logger, Now: func() time.Time { return fixedNow },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.handler, err = httpapi.NewRouter(httpapi.RouterOptions{
		Database: database.Reader, Ready: func() bool { return true },
		Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("SPA")}},
		Logger: logger, MaxBodyBytes: 1 << 20, BaseURL: base, Mounts: []httpapi.Mount{mount},
	})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) exec(statement string, args ...any) {
	f.t.Helper()
	if _, err := f.database.Writer.ExecContext(context.Background(), statement, args...); err != nil {
		f.t.Fatalf("%v\n%s", err, statement)
	}
}

func (f *fixture) publishBook(ctx context.Context, blobs *blobstore.Store, content []byte, format string) string {
	f.t.Helper()
	staged, err := blobs.StageBook(ctx, bytes.NewReader(content))
	if err != nil {
		f.t.Fatal(err)
	}
	if err := blobs.PublishBook(ctx, staged, format); err != nil {
		f.t.Fatal(err)
	}
	return staged.SHA256
}

type requestOptions struct {
	method   string
	user     string
	password string
	header   string
	remote   string
	host     string
}

func (f *fixture) do(target string, options requestOptions) *httptest.ResponseRecorder {
	f.t.Helper()
	method := options.method
	if method == "" {
		method = http.MethodGet
	}
	request := httptest.NewRequest(method, target, nil)
	if options.remote != "" {
		request.RemoteAddr = options.remote
	}
	if options.host != "" {
		request.Host = options.host
		request.Header.Set("X-Forwarded-Host", options.host)
	}
	switch {
	case options.header != "":
		request.Header.Set("Authorization", options.header)
	case options.user != "":
		request.SetBasicAuth(options.user, options.password)
	}
	response := httptest.NewRecorder()
	f.handler.ServeHTTP(response, request)
	return response
}

func (f *fixture) get(user, target string) *httptest.ResponseRecorder {
	f.t.Helper()
	return f.do(target, requestOptions{user: user, password: f.secrets[user]})
}

type parsedFeed struct {
	XMLName xml.Name      `xml:"http://www.w3.org/2005/Atom feed"`
	ID      string        `xml:"id"`
	Title   string        `xml:"title"`
	Links   []parsedLink  `xml:"link"`
	Entries []parsedEntry `xml:"entry"`
}

type parsedLink struct {
	XMLName xml.Name `xml:"link"`
	Rel     string   `xml:"rel,attr"`
	Href    string   `xml:"href,attr"`
	Type    string   `xml:"type,attr"`
	Title   string   `xml:"title,attr"`
	Length  string   `xml:"length,attr"`
}

type parsedEntry struct {
	ID           string   `xml:"id"`
	Title        string   `xml:"title"`
	Authors      []string `xml:"author>name"`
	Contributors []string `xml:"contributor>name"`
	Language     string   `xml:"http://purl.org/dc/terms/ language"`
	Publisher    string   `xml:"http://purl.org/dc/terms/ publisher"`
	Issued       string   `xml:"http://purl.org/dc/terms/ issued"`
	Identifiers  []string `xml:"http://purl.org/dc/terms/ identifier"`
	Summary      string   `xml:"summary"`
	Content      string   `xml:"content"`
	Categories   []struct {
		Term string `xml:"term,attr"`
	} `xml:"category"`
	Links []parsedLink `xml:"link"`
}

func (p parsedFeed) link(rel string) (parsedLink, bool) {
	for _, link := range p.Links {
		if link.Rel == rel {
			return link, true
		}
	}
	return parsedLink{}, false
}

func (p parsedFeed) entryIDs() []string {
	ids := make([]string, 0, len(p.Entries))
	for _, entry := range p.Entries {
		ids = append(ids, entry.ID)
	}
	return ids
}

// feed fetches, schema-validates, and decodes an OPDS feed.
func (f *fixture) feed(user, target, kind string) parsedFeed {
	f.t.Helper()
	response := f.get(user, target)
	if response.Code != http.StatusOK {
		f.t.Fatalf("GET %s as %s = %d %s", target, user, response.Code, response.Body.String())
	}
	wantType := map[string]string{"navigation": NavigationType, "acquisition": AcquisitionType}[kind] + ";charset=utf-8"
	if got := response.Header().Get("Content-Type"); got != wantType {
		f.t.Fatalf("GET %s content type = %q, want %q", target, got, wantType)
	}
	if err := validateOPDSFeed(response.Body.Bytes(), kind); err != nil {
		f.t.Fatalf("GET %s: %v\n%s", target, err, response.Body.String())
	}
	var result parsedFeed
	if err := xml.Unmarshal(response.Body.Bytes(), &result); err != nil {
		f.t.Fatal(err)
	}
	return result
}

func bookID(id int64) string { return fmt.Sprintf("urn:pandalibrary:book:%d", id) }

func TestAuthenticationRequiresOPDSAppPassword(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	kosyncKey := fmt.Sprintf("%x", md5.Sum([]byte(strings.ReplaceAll(f.kosync, "-", ""))))
	cases := []struct {
		name    string
		options requestOptions
	}{
		{"missing", requestOptions{}},
		{"malformed", requestOptions{header: "Basic !!!not-base64"}},
		{"bearer", requestOptions{header: "Bearer " + f.secrets["reader"]}},
		{"empty password", requestOptions{user: "reader"}},
		{"wrong password", requestOptions{user: "reader", password: "aaaa-bbbb-cccc-dddd"}},
		{"web password", requestOptions{user: "reader", password: "correct horse battery staple"}},
		{"kosync secret", requestOptions{user: "reader", password: f.kosync}},
		{"kosync key", requestOptions{user: "reader", password: kosyncKey}},
		{"other user's password", requestOptions{user: "reader", password: f.secrets["other"]}},
		{"disabled user", requestOptions{user: "disabled", password: f.secrets["disabled"]}},
		{"oversized username", requestOptions{user: strings.Repeat("a", 200), password: f.secrets["reader"]}},
	}
	for index, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			for targetIndex, target := range []string{"/opds", "/opds/books/101/files/201", "/opds/opensearch.xml", "/opds/nope"} {
				test.options.remote = fmt.Sprintf("198.51.100.%d:1234", index*4+targetIndex+1)
				response := f.do(target, test.options)
				if response.Code != http.StatusUnauthorized ||
					response.Header().Get("WWW-Authenticate") != `Basic realm="PandaLibrary OPDS", charset="UTF-8"` {
					t.Fatalf("%s = %d %q %s", target, response.Code,
						response.Header().Get("WWW-Authenticate"), response.Body.String())
				}
				if strings.Contains(response.Body.String(), "Panda") {
					t.Fatalf("unauthenticated response leaked catalog data: %s", response.Body.String())
				}
			}
		})
	}
	for _, user := range []string{"reader", "READER"} {
		response := f.do("/opds", requestOptions{user: user, password: f.secrets["reader"], remote: "203.0.113.9:1"})
		if response.Code != http.StatusOK {
			t.Fatalf("valid credentials for %q = %d %s", user, response.Code, response.Body.String())
		}
	}
	undashed := strings.ReplaceAll(f.secrets["reader"], "-", "")
	if response := f.do("/opds", requestOptions{user: "reader", password: undashed}); response.Code != http.StatusOK {
		t.Fatalf("undashed app password = %d", response.Code)
	}
}

func TestAuthenticationFailuresAreRateLimited(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	bad := requestOptions{user: "reader", password: "aaaa-bbbb-cccc-dddd", remote: "192.0.2.50:1"}
	for i := 0; i < 5; i++ {
		if response := f.do("/opds", bad); response.Code != http.StatusUnauthorized {
			t.Fatalf("attempt %d = %d", i+1, response.Code)
		}
	}
	good := requestOptions{user: "reader", password: f.secrets["reader"], remote: bad.remote}
	if response := f.do("/opds", good); response.Code != http.StatusTooManyRequests || response.Header().Get("Retry-After") == "" {
		t.Fatalf("limited attempt = %d", response.Code)
	}
	good.remote = "192.0.2.51:1"
	for i := 0; i < 10; i++ {
		if response := f.do("/opds", good); response.Code != http.StatusOK {
			t.Fatalf("successful request %d = %d", i+1, response.Code)
		}
	}
}

func TestRootNavigationAndOpenSearch(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	for _, target := range []string{"/opds", "/opds/"} {
		root := f.feed("reader", target, "navigation")
		want := []struct{ title, href, rel, kind string }{
			{"Recently added", "/opds/recent", relSortNew, AcquisitionType},
			{"Libraries", "/opds/libraries", "subsection", NavigationType},
			{"Authors", "/opds/authors", "subsection", NavigationType},
			{"Series", "/opds/series", "subsection", NavigationType},
			{"Tags", "/opds/tags", "subsection", NavigationType},
			{"Shelves", "/opds/shelves", "subsection", NavigationType},
			{"Reading now", "/opds/reading", "subsection", AcquisitionType},
			{"Want to read", "/opds/want-to-read", "subsection", AcquisitionType},
		}
		if len(root.Entries) != len(want) {
			t.Fatalf("root entries = %+v", root.Entries)
		}
		for index, entry := range root.Entries {
			link := entry.Links[0]
			if entry.Title != want[index].title || link.Href != want[index].href ||
				link.Rel != want[index].rel || link.Type != want[index].kind {
				t.Fatalf("root entry %d = %+v, want %+v", index, entry, want[index])
			}
		}
		if self, _ := root.link("self"); self.Href != "/opds" {
			t.Fatalf("self link = %+v", self)
		}
		if searchLink, _ := root.link("search"); searchLink.Href != "/opds/opensearch.xml" || searchLink.Type != OpenSearchType {
			t.Fatalf("search link = %+v", searchLink)
		}
	}
	response := f.get("reader", "/opds/opensearch.xml")
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != OpenSearchType+";charset=utf-8" {
		t.Fatalf("OpenSearch = %d %q", response.Code, response.Header().Get("Content-Type"))
	}
	if err := validateOpenSearch(response.Body.Bytes()); err != nil {
		t.Fatalf("%v\n%s", err, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `template="/opds/search?q={searchTerms}"`) {
		t.Fatalf("OpenSearch template: %s", response.Body.String())
	}
}

func TestNavigationFeedsApplyVisibility(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	libraries := f.feed("reader", "/opds/libraries", "navigation")
	if len(libraries.Entries) != 1 || libraries.Entries[0].Title != "Main & <Co>" ||
		libraries.Entries[0].Links[0].Href != "/opds/libraries/10" {
		t.Fatalf("reader libraries = %+v", libraries.Entries)
	}
	if up, _ := libraries.link("up"); up.Href != "/opds" {
		t.Fatalf("up link = %+v", up)
	}
	authors := f.feed("reader", "/opds/authors", "navigation")
	var names []string
	for _, entry := range authors.Entries {
		names = append(names, entry.Title)
	}
	if !slices.Equal(names, []string{"Ann Author", "Tran Slator"}) {
		t.Fatalf("reader authors = %v", names)
	}
	if authors.Entries[0].Content != "1 book" {
		t.Fatalf("author count content = %q", authors.Entries[0].Content)
	}
	tags := f.feed("reader", "/opds/tags", "navigation")
	if len(tags.Entries) != 1 || tags.Entries[0].Title != "Fantasy" {
		t.Fatalf("reader tags = %+v", tags.Entries)
	}
	series := f.feed("reader", "/opds/series", "navigation")
	if len(series.Entries) != 1 || series.Entries[0].Links[0].Href != "/opds/series/1" {
		t.Fatalf("reader series = %+v", series.Entries)
	}
	shelves := f.feed("reader", "/opds/shelves", "navigation")
	names = nil
	for _, entry := range shelves.Entries {
		names = append(names, entry.Title+"="+entry.Content)
	}
	if !slices.Equal(names, []string{"Mine=1 book", "Shared=Shared shelf · 1 book"}) {
		t.Fatalf("reader shelves = %v", names)
	}
	adminShelves := f.feed("admin", "/opds/shelves", "navigation")
	if len(adminShelves.Entries) != 3 {
		t.Fatalf("admin shelves = %+v", adminShelves.Entries)
	}
	adminLibraries := f.feed("admin", "/opds/libraries", "navigation")
	if len(adminLibraries.Entries) != 2 {
		t.Fatalf("admin libraries = %+v", adminLibraries.Entries)
	}
	for _, target := range []string{
		"/opds/libraries/20", "/opds/authors/3", "/opds/tags/2", "/opds/shelves/2", "/opds/shelves/999",
		"/opds/books/102/files/203", "/opds/books/103/cover", "/opds/books/101/files/203",
	} {
		if response := f.get("reader", target); response.Code != http.StatusNotFound ||
			strings.Contains(response.Body.String(), "Panda") {
			t.Fatalf("reader %s = %d %s", target, response.Code, response.Body.String())
		}
	}
}

func TestAcquisitionFeedsPaginateAndHideInvisibleBooks(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	first := f.feed("reader", "/opds/recent", "acquisition")
	if len(first.Entries) != pageSize || first.Entries[0].ID != bookID(101) {
		t.Fatalf("first recent page has %d entries starting %v", len(first.Entries), first.entryIDs()[:1])
	}
	next, ok := first.link("next")
	if !ok || next.Type != AcquisitionType || !strings.HasPrefix(next.Href, "/opds/recent?cursor=") {
		t.Fatalf("next link = %+v", next)
	}
	second := f.feed("reader", next.Href, "acquisition")
	if _, ok := second.link("next"); ok || len(second.Entries) != 62-pageSize {
		t.Fatalf("second page = %d entries, links %+v", len(second.Entries), second.Links)
	}
	if self, _ := second.link("self"); self.Href != next.Href {
		t.Fatalf("second self = %q, want %q", self.Href, next.Href)
	}
	all := append(first.entryIDs(), second.entryIDs()...)
	seen := map[string]bool{}
	for _, id := range all {
		if seen[id] {
			t.Fatalf("duplicate entry %s across pages", id)
		}
		seen[id] = true
	}
	for _, hidden := range []int64{102, 103, 105} {
		if seen[bookID(hidden)] {
			t.Fatalf("reader recent feed exposed book %d", hidden)
		}
	}
	if !seen[bookID(104)] {
		t.Fatal("reader should see book 104, which only the admin hid")
	}

	adminFirst := f.feed("admin", "/opds/recent", "acquisition")
	adminNext, _ := adminFirst.link("next")
	adminIDs := append(adminFirst.entryIDs(), f.feed("admin", adminNext.Href, "acquisition").entryIDs()...)
	if !slices.Contains(adminIDs, bookID(103)) || !slices.Contains(adminIDs, bookID(102)) ||
		slices.Contains(adminIDs, bookID(104)) {
		t.Fatalf("admin recent visibility is wrong: has103=%v has102=%v has104=%v",
			slices.Contains(adminIDs, bookID(103)), slices.Contains(adminIDs, bookID(102)), slices.Contains(adminIDs, bookID(104)))
	}
	if response := f.get("reader", next.Href); response.Code != http.StatusOK {
		t.Fatalf("cursor reuse = %d", response.Code)
	}
	if response := f.get("admin", next.Href); response.Code != http.StatusBadRequest {
		t.Fatalf("another viewer's cursor = %d %s", response.Code, response.Body.String())
	}
	if response := f.get("admin", "/opds/books/104/files/999"); response.Code != http.StatusNotFound {
		t.Fatalf("admin hidden book download = %d", response.Code)
	}

	library := f.feed("reader", "/opds/libraries/10", "acquisition")
	if len(library.Entries) != pageSize {
		t.Fatalf("library page = %d", len(library.Entries))
	}
	libraryNext, _ := library.link("next")
	if !strings.HasPrefix(libraryNext.Href, "/opds/libraries/10?cursor=") {
		t.Fatalf("library next = %+v", libraryNext)
	}
	if up, _ := library.link("up"); up.Href != "/opds/libraries" {
		t.Fatalf("library up = %+v", up)
	}

	for target, want := range map[string][]string{
		"/opds/authors/1":   {bookID(101)},
		"/opds/series/1":    {bookID(101)},
		"/opds/tags/1":      {bookID(101)},
		"/opds/shelves/1":   {bookID(101)},
		"/opds/shelves/3":   {bookID(1002)},
		"/opds/reading":     {bookID(101)},
		"/opds/search?q=pa": {bookID(101), bookID(104)},
	} {
		got := f.feed("reader", target, "acquisition").entryIDs()
		slices.Sort(got)
		if !slices.Equal(got, want) {
			t.Fatalf("reader %s = %v, want %v", target, got, want)
		}
	}
	if got := f.feed("admin", "/opds/reading", "acquisition").entryIDs(); len(got) != 0 {
		t.Fatalf("admin reading list includes own hidden book: %v", got)
	}
	if got := f.feed("admin", "/opds/shelves/3", "acquisition").entryIDs(); !slices.Equal(got, []string{bookID(103), bookID(1002)}) {
		t.Fatalf("admin shared shelf = %v", got)
	}
	if got := f.feed("admin", "/opds/shelves/2", "acquisition").entryIDs(); !slices.Equal(got, []string{bookID(1001)}) {
		t.Fatalf("admin view of another private shelf = %v", got)
	}

	want := f.feed("reader", "/opds/want-to-read", "acquisition")
	wantNext, ok := want.link("next")
	if len(want.Entries) != pageSize || !ok || !strings.HasPrefix(wantNext.Href, "/opds/want-to-read?cursor=") {
		t.Fatalf("want-to-read page = %d, next %+v", len(want.Entries), wantNext)
	}
	rest := f.feed("reader", wantNext.Href, "acquisition")
	statusIDs := append(want.entryIDs(), rest.entryIDs()...)
	if len(rest.Entries) != 5 || len(statusIDs) != 55 {
		t.Fatalf("want-to-read rest = %d", len(rest.Entries))
	}
	sortedUnique := slices.Clone(statusIDs)
	slices.Sort(sortedUnique)
	if len(slices.Compact(sortedUnique)) != 55 {
		t.Fatal("want-to-read pagination repeated a book")
	}
	if response := f.get("admin", wantNext.Href); response.Code != http.StatusBadRequest {
		t.Fatalf("status cursor reused by another viewer = %d", response.Code)
	}
	if response := f.get("reader", "/opds/reading?cursor="+strings.TrimPrefix(wantNext.Href, "/opds/want-to-read?cursor=")); response.Code != http.StatusBadRequest {
		t.Fatalf("status cursor reused across lists = %d", response.Code)
	}
}

func TestSearchUsesSearchServiceAndPreservesQuery(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	first := f.feed("reader", "/opds/search?q=filler", "acquisition")
	next, ok := first.link("next")
	if len(first.Entries) != pageSize || !ok {
		t.Fatalf("search page = %d next=%v", len(first.Entries), ok)
	}
	parsed, err := url.Parse(next.Href)
	if err != nil || parsed.Path != "/opds/search" || parsed.Query().Get("q") != "filler" || parsed.Query().Get("cursor") == "" {
		t.Fatalf("search next = %q", next.Href)
	}
	second := f.feed("reader", next.Href, "acquisition")
	if len(second.Entries) != 10 {
		t.Fatalf("second search page = %d", len(second.Entries))
	}
	if self, _ := first.link("self"); self.Href != "/opds/search?q=filler" {
		t.Fatalf("search self = %q", self.Href)
	}
	mismatched := "/opds/search?q=other&cursor=" + url.QueryEscape(parsed.Query().Get("cursor"))
	if response := f.get("reader", mismatched); response.Code != http.StatusBadRequest {
		t.Fatalf("cursor for another query = %d", response.Code)
	}
	for _, target := range []string{"/opds/search", "/opds/search?q=", "/opds/search?q=%20", "/opds/search?q=a&q=b"} {
		if response := f.get("reader", target); response.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d", target, response.Code)
		}
	}
	got := f.feed("reader", "/opds/search?q=panda", "acquisition").entryIDs()
	slices.Sort(got)
	if !slices.Equal(got, []string{bookID(101), bookID(104)}) {
		t.Fatalf("reader panda search = %v", got)
	}
	if got := f.feed("admin", "/opds/search?q=panda", "acquisition").entryIDs(); slices.Contains(got, bookID(104)) || len(got) != 3 {
		t.Fatalf("admin panda search = %v", got)
	}
}

func TestAcquisitionEntriesAndDownloads(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	response := f.get("reader", "/opds/authors/1")
	body := response.Body.String()
	for _, escaped := range []string{
		"Panda &amp; &lt;Friends&gt; &#34;One&#34;\uFFFD: A &lt;Tale&gt;",
		"&lt;b&gt;Bold&lt;/b&gt; &amp; more", "Pub &amp; Co",
	} {
		if !strings.Contains(body, escaped) {
			t.Fatalf("feed does not contain escaped %q:\n%s", escaped, body)
		}
	}
	feed := f.feed("reader", "/opds/authors/1", "acquisition")
	entry := feed.Entries[0]
	if entry.Title != "Panda & <Friends> \"One\"\uFFFD: A <Tale>" || !slices.Equal(entry.Authors, []string{"Ann Author"}) ||
		!slices.Equal(entry.Contributors, []string{"Tran Slator"}) || entry.Language != "en" ||
		entry.Publisher != "Pub & Co" || entry.Issued != "2020-01-02" ||
		!slices.Equal(entry.Identifiers, []string{"urn:isbn:9780000000002"}) ||
		len(entry.Categories) != 1 || entry.Categories[0].Term != "Fantasy" ||
		entry.Summary != "Series: Saga #2\n\n<b>Bold</b> & more" {
		t.Fatalf("entry metadata = %+v", entry)
	}
	links := map[string]parsedLink{}
	for _, link := range entry.Links {
		links[link.Rel+" "+link.Type] = link
	}
	wantLinks := map[string]parsedLink{
		relImage + " image/jpeg":                 {Href: "/opds/books/101/cover"},
		relThumbnail + " image/jpeg":             {Href: "/opds/books/101/thumbnail"},
		relAcquisition + " application/epub+zip": {Href: "/opds/books/101/files/201", Length: fmt.Sprint(len(f.epubBytes)), Title: "EPUB"},
		relAcquisition + " application/pdf":      {Href: "/opds/books/101/files/202", Length: "13", Title: "PDF"},
	}
	if len(links) != len(wantLinks) {
		t.Fatalf("entry links = %+v", entry.Links)
	}
	for key, want := range wantLinks {
		got := links[key]
		if got.Href != want.Href || got.Length != want.Length || got.Title != want.Title {
			t.Fatalf("link %s = %+v, want %+v", key, got, want)
		}
	}
	if strings.Contains(body, "/api/v1/") || strings.Contains(body, "files/") && strings.Contains(body, ".epub") {
		t.Fatalf("feed exposes internal URLs or storage paths:\n%s", body)
	}

	download := f.get("reader", "/opds/books/101/files/201")
	if download.Code != http.StatusOK || !bytes.Equal(download.Body.Bytes(), f.epubBytes) ||
		download.Header().Get("Content-Type") != "application/epub+zip" ||
		download.Header().Get("Content-Disposition") != `attachment; filename=panda.epub` {
		t.Fatalf("download = %d %v", download.Code, download.Header())
	}
	head := f.do("/opds/books/101/files/201", requestOptions{method: http.MethodHead, user: "reader", password: f.secrets["reader"]})
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != fmt.Sprint(len(f.epubBytes)) {
		t.Fatalf("HEAD download = %d %v", head.Code, head.Header())
	}
	cover := f.get("reader", "/opds/books/101/cover")
	if cover.Code != http.StatusOK || !bytes.Equal(cover.Body.Bytes(), f.coverFull) || cover.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("cover = %d %v", cover.Code, cover.Header())
	}
	if thumbnail := f.get("reader", "/opds/books/101/thumbnail"); thumbnail.Code != http.StatusOK ||
		thumbnail.Body.String() != "\xff\xd8\xff thumbnail" {
		t.Fatalf("thumbnail = %d", thumbnail.Code)
	}
	if missing := f.get("reader", "/opds/books/1001/cover"); missing.Code != http.StatusNotFound {
		t.Fatalf("missing cover = %d", missing.Code)
	}
}

func TestAbsoluteLinksUseOnlyTrustedBaseURL(t *testing.T) {
	relative := newFixture(t, fixtureOptions{})
	response := relative.do("/opds/recent", requestOptions{user: "reader", password: relative.secrets["reader"], host: "evil.example"})
	if strings.Contains(response.Body.String(), "evil.example") || strings.Contains(response.Body.String(), "http://example.com") {
		t.Fatalf("relative feed trusted the request host:\n%s", response.Body.String())
	}

	f := newFixture(t, fixtureOptions{baseURL: "https://books.example.org/panda/"})
	response = f.do("/opds/recent", requestOptions{user: "reader", password: f.secrets["reader"], host: "evil.example"})
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "evil.example") {
		t.Fatalf("base URL feed = %d\n%s", response.Code, response.Body.String())
	}
	feed := f.feed("reader", "/opds/recent", "acquisition")
	self, _ := feed.link("self")
	next, _ := feed.link("next")
	if self.Href != "https://books.example.org/panda/opds/recent" ||
		!strings.HasPrefix(next.Href, "https://books.example.org/panda/opds/recent?cursor=") {
		t.Fatalf("absolute links = %q %q", self.Href, next.Href)
	}
	for _, link := range feed.Entries[0].Links {
		if !strings.HasPrefix(link.Href, "https://books.example.org/panda/opds/books/101/") {
			t.Fatalf("entry link = %+v", link)
		}
	}
	search := f.get("reader", "/opds/opensearch.xml")
	if !strings.Contains(search.Body.String(), `template="https://books.example.org/panda/opds/search?q={searchTerms}"`) {
		t.Fatalf("absolute OpenSearch template:\n%s", search.Body.String())
	}
}

func TestErrorsStayInsideOPDS(t *testing.T) {
	f := newFixture(t, fixtureOptions{})
	for target, status := range map[string]int{
		"/opds/unknown":                     http.StatusNotFound,
		"/opds/books/abc/files/1":           http.StatusNotFound,
		"/opds/books/0/cover":               http.StatusNotFound,
		"/opds/libraries/-1":                http.StatusNotFound,
		"/opds/recent?cursor=garbage":       http.StatusBadRequest,
		"/opds/reading?cursor=garbage":      http.StatusBadRequest,
		"/opds/shelves/1?cursor=a&cursor=b": http.StatusBadRequest,
		"/opds/recent?cursor=":              http.StatusBadRequest,
	} {
		response := f.get("reader", target)
		if response.Code != status || response.Header().Get("Content-Type") != "application/problem+json" {
			t.Fatalf("%s = %d %q %s", target, response.Code, response.Header().Get("Content-Type"), response.Body.String())
		}
	}
	if response := f.get("reader", "/opds/recent?unknown=1"); response.Code != http.StatusOK {
		t.Fatalf("unknown client parameter = %d", response.Code)
	}
	response := f.do("/opds", requestOptions{method: http.MethodPost, user: "reader", password: f.secrets["reader"]})
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /opds = %d", response.Code)
	}
}

func TestValidatorRejectsInvalidFeeds(t *testing.T) {
	for name, document := range map[string]string{
		"missing id":        `<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x"/></feed>`,
		"bad date":          `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:x</id><title>x</title><updated>yesterday</updated><author><name>a</name></author><link rel="self" href="/x"/></feed>`,
		"bad href":          `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:x</id><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x y"/></feed>`,
		"no acquisition":    `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:x</id><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x"/><entry><id>urn:y</id><title>y</title><updated>2026-01-01T00:00:00Z</updated></entry></feed>`,
		"html summary":      `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:x</id><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x"/><entry><id>urn:y</id><title>y</title><updated>2026-01-01T00:00:00Z</updated><summary type="html">x</summary><link rel="http://opds-spec.org/acquisition" href="/f"/></entry></feed>`,
		"buy without price": `<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:x</id><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x"/><entry><id>urn:y</id><title>y</title><updated>2026-01-01T00:00:00Z</updated><link rel="http://opds-spec.org/acquisition/buy" href="/f"/></entry></feed>`,
		"unknown attribute": `<feed xmlns="http://www.w3.org/2005/Atom" foo="bar"><id>urn:x</id><title>x</title><updated>2026-01-01T00:00:00Z</updated><author><name>a</name></author><link rel="self" href="/x"/></feed>`,
	} {
		if err := validateOPDSFeed([]byte(document), "acquisition"); err == nil {
			t.Errorf("%s: validator accepted an invalid feed", name)
		}
	}
}
