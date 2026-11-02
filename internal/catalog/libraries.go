package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

func validateName(value, field string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 1024 || !utf8.ValidString(value) {
		return "", invalid(field + " must be a nonempty name of at most 1024 bytes")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", invalid(field + " must not contain control characters")
		}
	}
	return value, nil
}

func validateSlug(value string) (string, error) {
	if len(value) == 0 || len(value) > 128 {
		return "", invalid("slug must contain between 1 and 128 characters")
	}
	for i, r := range value {
		isLetterOrDigit := r >= 'a' && r <= 'z' || r >= '0' && r <= '9'
		if !isLetterOrDigit && (r != '-' || i == 0) {
			return "", invalid("slug must start with a lowercase letter or digit and contain only lowercase letters, digits, or hyphens")
		}
	}
	return value, nil
}

func checkLibraryUnique(ctx context.Context, queries *sqlc.Queries, id int64, name, slug string) error {
	names, err := queries.CatalogLibraryNameTaken(ctx, sqlc.CatalogLibraryNameTakenParams{
		Name: name, ExcludeID: id,
	})
	if err != nil {
		return fmt.Errorf("check library name: %w", err)
	}
	slugs, err := queries.CatalogLibrarySlugTaken(ctx, sqlc.CatalogLibrarySlugTakenParams{
		Slug: slug, ExcludeID: id,
	})
	if err != nil {
		return fmt.Errorf("check library slug: %w", err)
	}
	if names != 0 || slugs != 0 {
		return conflict("library name or slug is already in use")
	}
	return nil
}

func libraryInTx(ctx context.Context, queries *sqlc.Queries, viewer Viewer, id int64) (sqlc.Library, error) {
	row, err := queries.CatalogGetLibrary(ctx, sqlc.CatalogGetLibraryParams{
		LibraryID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return sqlc.Library{}, notFound(fmt.Errorf("get library: %w", err))
	}
	return row, nil
}

// CreateLibrary creates a library for an administrator.
func (s *Service) CreateLibrary(ctx context.Context, viewer Viewer, name, slug string) (Library, error) {
	if err := checkAdmin(viewer); err != nil {
		return Library{}, err
	}
	name, err := validateName(name, "library name")
	if err != nil {
		return Library{}, err
	}
	slug, err = validateSlug(slug)
	if err != nil {
		return Library{}, err
	}
	var result Library
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if err := checkLibraryUnique(ctx, queries, 0, name, slug); err != nil {
			return err
		}
		now := s.now().UnixMilli()
		row, err := queries.CatalogCreateLibrary(ctx, sqlc.CatalogCreateLibraryParams{
			Name: name, Slug: slug, CreatedAt: now, UpdatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("create library: %w", err)
		}
		result = libraryDTO(row)
		return nil
	})
	return result, err
}

// UpdateLibrary changes a library's name and/or slug.
func (s *Service) UpdateLibrary(ctx context.Context, viewer Viewer, id int64, patch LibraryPatch) (Library, error) {
	if err := checkAdmin(viewer); err != nil {
		return Library{}, err
	}
	if id < 1 || (!patch.Name.Set && !patch.Slug.Set) {
		return Library{}, invalid("library ID and at least one update are required")
	}
	if patch.Name.Set && patch.Name.Value == nil || patch.Slug.Set && patch.Slug.Value == nil {
		return Library{}, invalid("library name and slug cannot be null")
	}
	var result Library
	err := db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		row, err := libraryInTx(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		name, slug := row.Name, row.Slug
		if patch.Name.Set {
			name, err = validateName(*patch.Name.Value, "library name")
			if err != nil {
				return err
			}
		}
		if patch.Slug.Set {
			slug, err = validateSlug(*patch.Slug.Value)
			if err != nil {
				return err
			}
		}
		if err := checkLibraryUnique(ctx, queries, id, name, slug); err != nil {
			return err
		}
		updated, err := queries.CatalogUpdateLibrary(ctx, sqlc.CatalogUpdateLibraryParams{
			ID: id, Name: name, Slug: slug, UpdatedAt: s.now().UnixMilli(),
		})
		if err != nil {
			return fmt.Errorf("update library: %w", err)
		}
		result = libraryDTO(updated)
		return nil
	})
	return result, err
}

// DeleteLibrary removes an empty, non-default library.
func (s *Service) DeleteLibrary(ctx context.Context, viewer Viewer, id int64) error {
	if err := checkAdmin(viewer); err != nil {
		return err
	}
	if id < 1 {
		return invalid("library ID is invalid")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := libraryInTx(ctx, queries, viewer, id); err != nil {
			return err
		}
		count, err := queries.CatalogLibraryBookCount(ctx, id)
		if err != nil {
			return fmt.Errorf("count library books: %w", err)
		}
		if count > 0 {
			return conflict("library contains books")
		}
		setting, err := queries.CatalogDefaultLibrarySetting(ctx)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("read default library: %w", err)
		}
		if err == nil {
			var defaultID *int64
			if err := json.Unmarshal([]byte(setting), &defaultID); err != nil {
				return fmt.Errorf("decode default library setting: %w", err)
			}
			if defaultID != nil && *defaultID < 1 {
				return errors.New("default library setting is invalid")
			}
			if defaultID != nil && *defaultID == id {
				return conflict("default library must be reconfigured before deletion")
			}
		}
		deleted, err := queries.CatalogDeleteLibrary(ctx, id)
		if err != nil {
			return fmt.Errorf("delete library: %w", err)
		}
		if deleted != 1 {
			return ErrNotFound
		}
		return nil
	})
}

// ListAccess returns a library's administrator-visible access grants.
func (s *Service) ListAccess(ctx context.Context, viewer Viewer, libraryID int64, options PageOptions) (Page[AccessEntry], error) {
	if err := checkAdmin(viewer); err != nil {
		return Page[AccessEntry]{}, err
	}
	if libraryID < 1 {
		return Page[AccessEntry]{}, invalid("library ID is invalid")
	}
	scope := fmt.Sprintf("%s:%d", viewerScope(viewer), libraryID)
	limit, after, err := parsePage(options, "library_access", scope, "")
	if err != nil {
		return Page[AccessEntry]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[AccessEntry], error) {
		if _, err := libraryInTx(ctx, queries, viewer, libraryID); err != nil {
			return Page[AccessEntry]{}, err
		}
		rows, err := queries.CatalogListLibraryAccess(ctx, sqlc.CatalogListLibraryAccessParams{
			LibraryID: libraryID, AfterID: after.ID, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[AccessEntry]{}, fmt.Errorf("list library access: %w", err)
		}
		rows, next, err := paginate(rows, limit, func(row sqlc.CatalogListLibraryAccessRow) cursor {
			return cursor{Version: 1, Kind: "library_access", Scope: scope, ID: row.UserID}
		})
		if err != nil {
			return Page[AccessEntry]{}, err
		}
		items := make([]AccessEntry, 0, len(rows))
		for _, row := range rows {
			items = append(items, AccessEntry{UserID: row.UserID, GrantedAt: utcMillis(row.GrantedAt)})
		}
		return Page[AccessEntry]{Items: items, NextCursor: next}, nil
	})
}

// SetAccess grants or revokes a regular user's library access.
func (s *Service) SetAccess(ctx context.Context, viewer Viewer, libraryID, userID int64, grant bool) error {
	if err := checkAdmin(viewer); err != nil {
		return err
	}
	if libraryID < 1 || userID < 1 {
		return invalid("library and user IDs must be positive")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := libraryInTx(ctx, queries, viewer, libraryID); err != nil {
			return err
		}
		role, err := queries.CatalogUserRole(ctx, userID)
		if err != nil {
			return notFound(fmt.Errorf("get grant user: %w", err))
		}
		if grant {
			if role != "user" {
				return invalid("administrators already have access to every library")
			}
			if err := queries.CatalogGrantLibraryAccess(ctx, sqlc.CatalogGrantLibraryAccessParams{
				LibraryID: libraryID, UserID: userID, GrantedAt: s.now().UnixMilli(),
			}); err != nil {
				return fmt.Errorf("grant library access: %w", err)
			}
		} else if err := queries.CatalogRevokeLibraryAccess(ctx, sqlc.CatalogRevokeLibraryAccessParams{
			LibraryID: libraryID, UserID: userID,
		}); err != nil {
			return fmt.Errorf("revoke library access: %w", err)
		}
		return nil
	})
}

// ListHidden returns hide-list configuration without exposing book metadata.
func (s *Service) ListHidden(ctx context.Context, viewer Viewer, userID int64, options PageOptions) (Page[HiddenEntry], error) {
	if err := checkAdmin(viewer); err != nil {
		return Page[HiddenEntry]{}, err
	}
	if userID < 1 {
		return Page[HiddenEntry]{}, invalid("user ID is invalid")
	}
	scope := fmt.Sprintf("%s:%d", viewerScope(viewer), userID)
	limit, after, err := parsePage(options, "hidden_books", scope, "")
	if err != nil {
		return Page[HiddenEntry]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[HiddenEntry], error) {
		if _, err := queries.CatalogUserRole(ctx, userID); err != nil {
			return Page[HiddenEntry]{}, notFound(fmt.Errorf("get hide-list user: %w", err))
		}
		rows, err := queries.CatalogListHiddenBooks(ctx, sqlc.CatalogListHiddenBooksParams{
			UserID: userID, AfterID: after.ID, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[HiddenEntry]{}, fmt.Errorf("list hidden books: %w", err)
		}
		rows, next, err := paginate(rows, limit, func(row sqlc.CatalogListHiddenBooksRow) cursor {
			return cursor{Version: 1, Kind: "hidden_books", Scope: scope, ID: row.BookID}
		})
		if err != nil {
			return Page[HiddenEntry]{}, err
		}
		items := make([]HiddenEntry, 0, len(rows))
		for _, row := range rows {
			items = append(items, HiddenEntry{
				BookID: row.BookID, HiddenBy: intPointer(row.HiddenBy), CreatedAt: utcMillis(row.CreatedAt),
			})
		}
		return Page[HiddenEntry]{Items: items, NextCursor: next}, nil
	})
}

// SetHidden adds or removes a user's hide-list entry without reading book metadata.
func (s *Service) SetHidden(ctx context.Context, viewer Viewer, userID, bookID int64, hidden bool) error {
	if err := checkAdmin(viewer); err != nil {
		return err
	}
	if userID < 1 || bookID < 1 {
		return invalid("user and book IDs must be positive")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := queries.CatalogUserRole(ctx, userID); err != nil {
			return notFound(fmt.Errorf("get hide-list user: %w", err))
		}
		count, err := queries.CatalogBookExists(ctx, bookID)
		if err != nil {
			return fmt.Errorf("check hide-list book: %w", err)
		}
		if count == 0 {
			return ErrNotFound
		}
		if hidden {
			if err := queries.CatalogHideBook(ctx, sqlc.CatalogHideBookParams{
				UserID: userID, BookID: bookID,
				HiddenBy: sql.NullInt64{Int64: viewer.UserID, Valid: true}, CreatedAt: s.now().UnixMilli(),
			}); err != nil {
				return fmt.Errorf("hide book: %w", err)
			}
		} else if err := queries.CatalogUnhideBook(ctx, sqlc.CatalogUnhideBookParams{
			UserID: userID, BookID: bookID,
		}); err != nil {
			return fmt.Errorf("unhide book: %w", err)
		}
		return nil
	})
}
