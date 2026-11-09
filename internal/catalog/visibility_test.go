package catalog

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/db/sqlc"
	"pandalibrary/internal/reading"
)

type catalogFixture struct {
	service *Service
	db      *db.DB
	store   *blobstore.Store
	root    string
	files   map[int64]int64
}

func newCatalogFixture(t *testing.T) catalogFixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	path := filepath.Join(root, "catalog.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close databases: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.Options{AutoMigrate: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := blobstore.New(root)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewService(databases.Writer, databases.Reader, store)
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.UnixMilli(123456789) }
	statements := []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'admin', 'x', 'admin', 1, 1), (2, 'reader', 'x', 'user', 1, 1),
			(3, 'other', 'x', 'user', 1, 1), (4, 'ungranted', 'x', 'user', 1, 1)`,
		`INSERT INTO libraries (id, name, slug, created_at, updated_at) VALUES
			(10, 'Main', 'main', 1, 1), (20, 'Private', 'private', 1, 1), (30, 'Empty', 'empty', 1, 1)`,
		`INSERT INTO library_access (library_id, user_id, granted_at) VALUES (10, 2, 1), (20, 3, 1), (30, 2, 1)`,
		`INSERT INTO authors (id, name, sort_name, created_at) VALUES
			(1, 'Shared Author', 'Shared Author', 1), (2, 'Secret Author', 'Secret Author', 1)`,
		`INSERT INTO series (id, name, created_at) VALUES (1, 'Shared Series', 1), (2, 'Secret Series', 1)`,
		`INSERT INTO tags (id, name, created_at) VALUES (1, 'Shared Tag', 1), (2, 'Secret Tag', 1)`,
		`INSERT INTO books (id, library_id, title, sort_title, series_id, series_index, created_at, updated_at) VALUES
			(101, 10, 'Tie A', 'tie', 1, 1, 100, 100),
			(102, 10, 'Hidden', 'alpha', 1, 1, 100, 100),
			(103, 20, 'Secret', 'secret', 2, NULL, 100, 100),
			(104, 10, 'Tie B', 'tie', 1, NULL, 100, 100)`,
		`INSERT INTO book_authors (book_id, author_id, role, position) VALUES
			(101, 1, 'author', 0), (102, 1, 'author', 0), (103, 1, 'author', 0),
			(103, 2, 'translator', 1), (104, 1, 'author', 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES (101, 1), (102, 1), (103, 1), (103, 2), (104, 1)`,
		`INSERT INTO book_identifiers (book_id, scheme, value) VALUES
			(101, 'isbn13', 'id-101'), (102, 'isbn13', 'id-102'),
			(103, 'isbn13', 'id-103'), (104, 'isbn13', 'id-104')`,
		`INSERT INTO book_field_sources (book_id, field, source, chosen_by, chosen_at) VALUES
			(101, 'title', 'file', 1, 1), (102, 'title', 'file', 1, 1),
			(103, 'title', 'file', 1, 1), (104, 'title', 'file', 1, 1)`,
		`INSERT INTO book_hidden (user_id, book_id, hidden_by, created_at) VALUES (2, 102, 1, 1), (1, 103, 1, 1)`,
	}
	for _, statement := range statements {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatalf("seed catalog: %v", err)
		}
	}
	cover := []byte("shared cover")
	coverSum := sha256.Sum256(cover)
	coverHash := hex.EncodeToString(coverSum[:])
	if err := store.PublishCover(coverHash, cover, []byte("shared thumbnail")); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `UPDATE books SET cover_sha256 = ?`, coverHash); err != nil {
		t.Fatal(err)
	}
	files := make(map[int64]int64)
	for id := int64(101); id <= 104; id++ {
		content := []byte(fmt.Sprintf("book-%d", id))
		sum := sha256.Sum256(content)
		hash := hex.EncodeToString(sum[:])
		name, err := blobstore.BookPath(hash, "epub")
		if err != nil {
			t.Fatal(err)
		}
		absolute := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(absolute), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, content, 0o600); err != nil {
			t.Fatal(err)
		}
		fileID := id + 100
		if _, err := databases.Writer.ExecContext(ctx, `
			INSERT INTO book_files (id, book_id, sha256, format, size_bytes, original_filename, created_at)
			VALUES (?, ?, ?, 'epub', ?, 'book.epub', 1)`, fileID, id, hash, len(content)); err != nil {
			t.Fatal(err)
		}
		files[id] = fileID
	}
	return catalogFixture{service: service, db: databases, store: store, root: root, files: files}
}

type visibilityCase struct {
	name    string
	viewer  Viewer
	visible map[int64]bool
}

func visibilityCases() []visibilityCase {
	return []visibilityCase{
		{"admin", Viewer{UserID: 1, IsAdmin: true}, map[int64]bool{101: true, 102: true, 104: true}},
		{"reader", Viewer{UserID: 2}, map[int64]bool{101: true, 104: true}},
		{"other", Viewer{UserID: 3}, map[int64]bool{103: true}},
		{"ungranted", Viewer{UserID: 4}, map[int64]bool{}},
	}
}

type visibilityRead struct {
	name string
	read func() (bool, error)
}

func manyVisible[T any](items []T, err error) (bool, error) {
	return len(items) != 0, err
}

func oneVisible[T any](_ T, err error) (bool, error) {
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// Keep this list in sync with all book-derived single-book sqlc reads.
func bookVisibilityReads(ctx context.Context, queries *sqlc.Queries, viewer Viewer, bookID, fileID int64) []visibilityRead {
	admin, userID := adminFlag(viewer), viewer.UserID
	return []visibilityRead{
		{"CatalogGetBook", func() (bool, error) {
			return oneVisible(queries.CatalogGetBook(ctx, sqlc.CatalogGetBookParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookAuthors", func() (bool, error) {
			return manyVisible(queries.CatalogBookAuthors(ctx, sqlc.CatalogBookAuthorsParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookSeries", func() (bool, error) {
			return oneVisible(queries.CatalogBookSeries(ctx, sqlc.CatalogBookSeriesParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookTags", func() (bool, error) {
			return manyVisible(queries.CatalogBookTags(ctx, sqlc.CatalogBookTagsParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookIdentifiers", func() (bool, error) {
			return manyVisible(queries.CatalogBookIdentifiers(ctx, sqlc.CatalogBookIdentifiersParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookFiles", func() (bool, error) {
			return manyVisible(queries.CatalogBookFiles(ctx, sqlc.CatalogBookFilesParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookFile", func() (bool, error) {
			return oneVisible(queries.CatalogBookFile(ctx, sqlc.CatalogBookFileParams{BookID: bookID, FileID: fileID, IsAdmin: admin, UserID: userID}))
		}},
		{"CatalogBookFieldSources", func() (bool, error) {
			return manyVisible(queries.CatalogBookFieldSources(ctx, sqlc.CatalogBookFieldSourcesParams{BookID: bookID, IsAdmin: admin, UserID: userID}))
		}},
	}
}

func TestBookDerivedReadVisibility(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	queries := sqlc.New(fixture.db.Reader)
	readingService, err := reading.NewService(fixture.db.Writer, fixture.db.Reader)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range visibilityCases() {
		t.Run(test.name, func(t *testing.T) {
			for _, id := range []int64{101, 102, 103, 104, 999} {
				want := test.visible[id]
				_, readingErr := readingService.GetBookState(ctx, reading.Viewer{
					UserID: test.viewer.UserID, IsAdmin: test.viewer.IsAdmin,
				}, id)
				if want && readingErr != nil {
					t.Errorf("reading state for visible book %d: %v", id, readingErr)
				} else if !want && !errors.Is(readingErr, reading.ErrNotFound) {
					t.Errorf("reading state for invisible book %d: got %v, want not found", id, readingErr)
				}
				for _, read := range bookVisibilityReads(ctx, queries, test.viewer, id, fixture.files[id]) {
					visible, err := read.read()
					if err != nil || visible != want {
						t.Errorf("%s book %d visible = %t, %v; want %t", read.name, id, visible, err, want)
					}
				}
				book, err := fixture.service.GetBook(ctx, test.viewer, id)
				if want {
					if err != nil || book.ID != id || len(book.Authors) == 0 || len(book.Tags) == 0 ||
						len(book.Identifiers) != 1 || len(book.Files) != 1 || len(book.FieldSources) != 1 ||
						book.Series == nil || book.CoverURL == nil {
						t.Errorf("GetBook(%d) = %+v, %v", id, book, err)
					}
				} else if !errors.Is(err, ErrNotFound) {
					t.Errorf("GetBook(%d) error = %v, want not found", id, err)
				}
				for _, open := range []struct {
					name string
					fn   func() (Content, error)
				}{
					{"file", func() (Content, error) {
						return fixture.service.OpenBookFile(ctx, test.viewer, id, id+100, "")
					}},
					{"cover", func() (Content, error) {
						return fixture.service.OpenCover(ctx, test.viewer, id, false)
					}},
					{"thumbnail", func() (Content, error) {
						return fixture.service.OpenCover(ctx, test.viewer, id, true)
					}},
				} {
					content, err := open.fn()
					if want {
						if err != nil {
							t.Errorf("open %s %d: %v", open.name, id, err)
						} else if err := content.File.Close(); err != nil {
							t.Error(err)
						}
					} else if !errors.Is(err, ErrNotFound) {
						t.Errorf("open %s %d: got %v, want not found", open.name, id, err)
					}
				}
			}
			for _, sort := range []string{"title", "added", "series"} {
				filters := BookFilters{Sort: sort}
				if sort == "series" {
					filters.SeriesID = 1
				}
				page, err := fixture.service.ListBooks(ctx, test.viewer, filters, PageOptions{})
				if err != nil {
					t.Fatalf("list %s: %v", sort, err)
				}
				got := make(map[int64]bool)
				for _, book := range page.Items {
					got[book.ID] = true
				}
				want := make(map[int64]bool)
				for id := range test.visible {
					if sort != "series" || id != 103 {
						want[id] = true
					}
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("%s list IDs = %v, want %v", sort, got, want)
				}
			}
		})
	}
}

func TestCountBooksVisibility(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	for _, test := range visibilityCases() {
		t.Run(test.name, func(t *testing.T) {
			count, err := fixture.service.CountBooks(ctx, test.viewer)
			if err != nil || count != int64(len(test.visible)) {
				t.Fatalf("count = %d, %v, want %d", count, err, len(test.visible))
			}
			var listed int64
			options := PageOptions{Limit: 1}
			for {
				page, err := fixture.service.ListBooks(ctx, test.viewer, BookFilters{}, options)
				if err != nil {
					t.Fatal(err)
				}
				listed += int64(len(page.Items))
				if page.NextCursor == nil {
					break
				}
				options.Cursor = *page.NextCursor
			}
			if count != listed {
				t.Errorf("count = %d, paged list has %d books", count, listed)
			}
		})
	}
	admin := Viewer{UserID: 1, IsAdmin: true}
	if err := fixture.service.SetHidden(ctx, admin, 1, 103, false); err != nil {
		t.Fatal(err)
	}
	if count, err := fixture.service.CountBooks(ctx, admin); err != nil || count != 4 {
		t.Fatalf("admin count after unhide = %d, %v, want 4", count, err)
	}
	if count, err := fixture.service.CountBooks(ctx, Viewer{UserID: 2}); err != nil || count != 2 {
		t.Fatalf("reader count after admin unhide = %d, %v, want 2", count, err)
	}
	if err := fixture.service.SetAccess(ctx, admin, 10, 3, true); err != nil {
		t.Fatal(err)
	}
	if count, err := fixture.service.CountBooks(ctx, Viewer{UserID: 3}); err != nil || count != 4 {
		t.Fatalf("other reader count after grant = %d, %v, want 4", count, err)
	}
}

func TestCountBooksErrors(t *testing.T) {
	fixture := newCatalogFixture(t)
	for _, viewer := range []Viewer{{}, {UserID: -1}, {IsAdmin: true}} {
		if _, err := fixture.service.CountBooks(context.Background(), viewer); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid viewer %+v: %v, want ErrInvalid", viewer, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fixture.service.CountBooks(ctx, Viewer{UserID: 2}); !errors.Is(err, context.Canceled) {
		t.Errorf("canceled count error = %v, want context.Canceled", err)
	}
}

func TestCatalogFilteredListsAndEntityCounts(t *testing.T) {
	fixture := newCatalogFixture(t)
	ctx := context.Background()
	if _, err := fixture.db.Writer.ExecContext(ctx, `
		INSERT INTO book_authors (book_id, author_id, role, position) VALUES (101, 1, 'editor', 2)`); err != nil {
		t.Fatal(err)
	}
	for _, test := range visibilityCases() {
		t.Run(test.name, func(t *testing.T) {
			for _, filter := range []BookFilters{
				{LibraryID: 10}, {LibraryID: 20}, {AuthorID: 1}, {AuthorID: 2},
				{SeriesID: 1}, {SeriesID: 2}, {TagID: 1}, {TagID: 2},
				{LibraryID: 10, AuthorID: 1, SeriesID: 1, TagID: 1},
			} {
				page, err := fixture.service.ListBooks(ctx, test.viewer, filter, PageOptions{})
				if err != nil {
					t.Fatal(err)
				}
				got := make(map[int64]bool)
				for _, book := range page.Items {
					got[book.ID] = true
				}
				want := make(map[int64]bool)
				for id := range test.visible {
					private := id == 103
					if (filter.LibraryID == 10 && private) || (filter.LibraryID == 20 && !private) ||
						(filter.AuthorID == 2 && !private) || (filter.SeriesID == 1 && private) ||
						(filter.SeriesID == 2 && !private) || (filter.TagID == 2 && !private) {
						continue
					}
					want[id] = true
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("filter %+v IDs = %v, want %v", filter, got, want)
				}
			}
			expected := map[string]map[int64]int64{
				"authors": {}, "series": {}, "tags": {},
			}
			for id := range test.visible {
				expected["authors"][1]++
				expected["tags"][1]++
				seriesID := int64(1)
				if id == 103 {
					seriesID = 2
					expected["authors"][2]++
					expected["tags"][2]++
				}
				expected["series"][seriesID]++
			}
			for _, kind := range []string{"authors", "series", "tags"} {
				page, err := fixture.service.ListEntities(ctx, test.viewer, kind, PageOptions{})
				if err != nil {
					t.Fatal(err)
				}
				got := make(map[int64]int64)
				for _, entity := range page.Items {
					got[entity.ID] = entity.VisibleBookCount
				}
				if !reflect.DeepEqual(got, expected[kind]) {
					t.Errorf("%s counts = %v, want %v", kind, got, expected[kind])
				}
				for _, id := range []int64{1, 2, 999} {
					entity, err := fixture.service.GetEntity(ctx, test.viewer, kind, id)
					if count, ok := expected[kind][id]; ok {
						if err != nil || entity.VisibleBookCount != count {
							t.Errorf("%s/%d = %+v, %v, want count %d", kind, id, entity, err, count)
						}
					} else if !errors.Is(err, ErrNotFound) {
						t.Errorf("%s/%d error = %v, want not found", kind, id, err)
					}
				}
			}
		})
	}
	readerLibraries, err := fixture.service.ListLibraries(ctx, Viewer{UserID: 2}, PageOptions{})
	if err != nil || len(readerLibraries.Items) != 2 || readerLibraries.Items[0].ID != 30 || readerLibraries.Items[1].ID != 10 {
		t.Fatalf("reader libraries = %+v, %v", readerLibraries, err)
	}
	if _, err := fixture.service.GetLibrary(ctx, Viewer{UserID: 2}, 20); !errors.Is(err, ErrNotFound) {
		t.Fatalf("inaccessible library error = %v", err)
	}
}
