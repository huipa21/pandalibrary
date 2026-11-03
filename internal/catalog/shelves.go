package catalog

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

// Shelf is shelf metadata with a count filtered for the requesting viewer.
// OwnerID, Description, and CreatedBy are null when not present; timestamps are UTC.
type Shelf struct {
	ID               int64     `json:"id"`
	Kind             string    `json:"kind"`
	OwnerID          *int64    `json:"owner_id"`
	Name             string    `json:"name"`
	Description      *string   `json:"description"`
	CreatedBy        *int64    `json:"created_by"`
	VisibleBookCount int64     `json:"visible_book_count"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// ShelfInput creates a private or shared shelf; Description may be null.
type ShelfInput struct {
	Kind        string  `json:"kind"`
	Name        string  `json:"name"`
	Description *string `json:"description"`
}

// ShelfPatch distinguishes omitted fields from an explicit null description.
type ShelfPatch struct {
	Name        Optional[string] `json:"name"`
	Description Optional[string] `json:"description"`
}

func shelfDTO(row sqlc.Shelf, count int64) Shelf {
	return Shelf{
		ID: row.ID, Kind: row.Kind, OwnerID: intPointer(row.OwnerID),
		Name: row.Name, Description: stringPointer(row.Description), CreatedBy: intPointer(row.CreatedBy),
		VisibleBookCount: count, CreatedAt: utcMillis(row.CreatedAt), UpdatedAt: utcMillis(row.UpdatedAt),
	}
}

func shelfDescription(value *string) (sql.NullString, error) {
	if value == nil {
		return sql.NullString{}, nil
	}
	if len(*value) > 1<<20 || !utf8.ValidString(*value) || strings.ContainsRune(*value, 0) {
		return sql.NullString{}, invalid("shelf description is invalid or too long")
	}
	return sql.NullString{String: *value, Valid: true}, nil
}

func shelfForViewer(ctx context.Context, queries *sqlc.Queries, viewer Viewer, id int64) (sqlc.Shelf, error) {
	row, err := queries.ShelfGet(ctx, sqlc.ShelfGetParams{
		ShelfID: id, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return sqlc.Shelf{}, notFound(fmt.Errorf("get shelf: %w", err))
	}
	return row, nil
}

func checkShelfManager(viewer Viewer, shelf sqlc.Shelf) error {
	if viewer.IsAdmin || shelf.Kind == "private" && shelf.OwnerID.Valid && shelf.OwnerID.Int64 == viewer.UserID {
		return nil
	}
	return ErrForbidden
}

func visibleShelfCount(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelfID int64) (int64, error) {
	count, err := queries.ShelfVisibleBookCount(ctx, sqlc.ShelfVisibleBookCountParams{
		ShelfID: shelfID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return 0, fmt.Errorf("count visible shelf books: %w", err)
	}
	return count, nil
}

func checkShelfName(ctx context.Context, queries *sqlc.Queries, row sqlc.Shelf, name string) error {
	count, err := queries.ShelfNameTaken(ctx, sqlc.ShelfNameTakenParams{
		Kind: row.Kind, OwnerID: row.OwnerID, Name: name, ExcludeID: row.ID,
	})
	if err != nil {
		return fmt.Errorf("check shelf name: %w", err)
	}
	if count != 0 {
		return conflict("shelf name is already in use")
	}
	return nil
}

// ListShelves lists the viewer's private shelves and shared shelves; admins see all.
func (s *Service) ListShelves(ctx context.Context, viewer Viewer, options PageOptions) (Page[Shelf], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Shelf]{}, err
	}
	scope := viewerScope(viewer)
	limit, after, err := parsePage(options, "shelves", scope, "name")
	if err != nil {
		return Page[Shelf]{}, err
	}
	afterName := ""
	if after.ID != 0 {
		name, err := base64.RawURLEncoding.DecodeString(after.Text)
		if err != nil || len(name) == 0 || len(name) > 1024 || !utf8.Valid(name) {
			return Page[Shelf]{}, invalid("cursor is invalid")
		}
		afterName = string(name)
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Shelf], error) {
		rows, err := queries.ShelfList(ctx, sqlc.ShelfListParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
			AfterName: afterName, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Shelf]{}, fmt.Errorf("list shelves: %w", err)
		}
		rows, next, err := paginate(rows, limit, func(row sqlc.Shelf) cursor {
			return cursor{
				Version: 1, Kind: "shelves", Scope: scope, Sort: "name", ID: row.ID,
				Text: base64.RawURLEncoding.EncodeToString([]byte(row.Name)),
			}
		})
		if err != nil {
			return Page[Shelf]{}, err
		}
		items := make([]Shelf, 0, len(rows))
		for _, row := range rows {
			count, err := visibleShelfCount(ctx, queries, viewer, row.ID)
			if err != nil {
				return Page[Shelf]{}, err
			}
			items = append(items, shelfDTO(row, count))
		}
		return Page[Shelf]{Items: items, NextCursor: next}, nil
	})
}

// GetShelf returns accessible shelf metadata and the viewer's visible-book count.
func (s *Service) GetShelf(ctx context.Context, viewer Viewer, id int64) (Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return Shelf{}, err
	}
	if id < 1 {
		return Shelf{}, invalid("shelf ID is invalid")
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Shelf, error) {
		row, err := shelfForViewer(ctx, queries, viewer, id)
		if err != nil {
			return Shelf{}, err
		}
		count, err := visibleShelfCount(ctx, queries, viewer, id)
		if err != nil {
			return Shelf{}, err
		}
		return shelfDTO(row, count), nil
	})
}

// CreateShelf creates a private shelf for the viewer, or a shared shelf for an admin.
func (s *Service) CreateShelf(ctx context.Context, viewer Viewer, input ShelfInput) (Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return Shelf{}, err
	}
	if input.Kind != "private" && input.Kind != "shared" {
		return Shelf{}, invalid("shelf kind must be private or shared")
	}
	if input.Kind == "shared" && !viewer.IsAdmin {
		return Shelf{}, ErrForbidden
	}
	name, err := validateName(input.Name, "shelf name")
	if err != nil {
		return Shelf{}, err
	}
	description, err := shelfDescription(input.Description)
	if err != nil {
		return Shelf{}, err
	}
	owner := sql.NullInt64{}
	if input.Kind == "private" {
		owner = sql.NullInt64{Int64: viewer.UserID, Valid: true}
	}
	var result Shelf
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if err := checkShelfName(ctx, queries, sqlc.Shelf{Kind: input.Kind, OwnerID: owner}, name); err != nil {
			return err
		}
		now := s.now().UnixMilli()
		row, err := queries.ShelfCreate(ctx, sqlc.ShelfCreateParams{
			Kind: input.Kind, OwnerID: owner, Name: name, Description: description,
			CreatedBy: sql.NullInt64{Int64: viewer.UserID, Valid: true}, CreatedAt: now, UpdatedAt: now,
		})
		if err != nil {
			return fmt.Errorf("create shelf: %w", err)
		}
		result = shelfDTO(row, 0)
		return nil
	})
	return result, err
}

// UpdateShelf updates the name and/or description of a shelf managed by the viewer.
func (s *Service) UpdateShelf(ctx context.Context, viewer Viewer, id int64, patch ShelfPatch) (Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return Shelf{}, err
	}
	if id < 1 || !patch.Name.Set && !patch.Description.Set {
		return Shelf{}, invalid("shelf ID and at least one update are required")
	}
	var name string
	var description sql.NullString
	var err error
	if patch.Name.Set {
		if patch.Name.Value == nil {
			return Shelf{}, invalid("shelf name cannot be null")
		}
		name, err = validateName(*patch.Name.Value, "shelf name")
		if err != nil {
			return Shelf{}, err
		}
	}
	if patch.Description.Set {
		description, err = shelfDescription(patch.Description.Value)
		if err != nil {
			return Shelf{}, err
		}
	}
	var result Shelf
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		row, err := shelfForViewer(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		if err := checkShelfManager(viewer, row); err != nil {
			return err
		}
		if !patch.Name.Set {
			name = row.Name
		}
		if !patch.Description.Set {
			description = row.Description
		}
		if err := checkShelfName(ctx, queries, row, name); err != nil {
			return err
		}
		updated, err := queries.ShelfUpdate(ctx, sqlc.ShelfUpdateParams{
			ID: id, Name: name, Description: description, UpdatedAt: s.now().UnixMilli(),
		})
		if err != nil {
			return fmt.Errorf("update shelf: %w", err)
		}
		count, err := visibleShelfCount(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		result = shelfDTO(updated, count)
		return nil
	})
	return result, err
}

// DeleteShelf deletes a shelf managed by the viewer.
func (s *Service) DeleteShelf(ctx context.Context, viewer Viewer, id int64) error {
	if err := checkViewer(viewer); err != nil {
		return err
	}
	if id < 1 {
		return invalid("shelf ID is invalid")
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		row, err := shelfForViewer(ctx, queries, viewer, id)
		if err != nil {
			return err
		}
		if err := checkShelfManager(viewer, row); err != nil {
			return err
		}
		deleted, err := queries.ShelfDelete(ctx, id)
		if err != nil {
			return fmt.Errorf("delete shelf: %w", err)
		}
		if deleted != 1 {
			return ErrNotFound
		}
		return nil
	})
}
