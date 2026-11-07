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
// OwnerID, Description, CreatedBy, SystemKey, and Rules are null when not present;
// Mode is "manual" or "automatic"; timestamps are UTC.
type Shelf struct {
	ID               int64     `json:"id"`
	Kind             string    `json:"kind"`
	Mode             string    `json:"mode"`
	SystemKey        *string   `json:"system_key"`
	Rules            *RuleSet  `json:"rules"`
	OwnerID          *int64    `json:"owner_id"`
	Name             string    `json:"name"`
	Description      *string   `json:"description"`
	CreatedBy        *int64    `json:"created_by"`
	VisibleBookCount int64     `json:"visible_book_count"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// ShelfInput creates a private or shared shelf; Description may be null. An omitted
// Mode means manual. Automatic shelves must be private and require Rules.
type ShelfInput struct {
	Kind        string   `json:"kind"`
	Mode        string   `json:"mode"`
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	Rules       *RuleSet `json:"rules"`
}

// ShelfPatch distinguishes omitted fields from an explicit null description.
// Mode may only repeat the current mode; Rules may only change on automatic shelves.
type ShelfPatch struct {
	Name        Optional[string]  `json:"name"`
	Description Optional[string]  `json:"description"`
	Mode        Optional[string]  `json:"mode"`
	Rules       Optional[RuleSet] `json:"rules"`
}

func shelfDTO(row sqlc.Shelf, count int64) (Shelf, error) {
	shelf := Shelf{
		ID: row.ID, Kind: row.Kind, Mode: row.Mode, SystemKey: stringPointer(row.SystemKey),
		OwnerID: intPointer(row.OwnerID), Name: row.Name, Description: stringPointer(row.Description),
		CreatedBy: intPointer(row.CreatedBy), VisibleBookCount: count,
		CreatedAt: utcMillis(row.CreatedAt), UpdatedAt: utcMillis(row.UpdatedAt),
	}
	if row.Rules.Valid {
		rules, err := decodeStoredRules(row.Rules.String)
		if err != nil {
			return Shelf{}, err
		}
		shelf.Rules = rules
	}
	return shelf, nil
}

func checkShelfMutable(shelf sqlc.Shelf) error {
	if shelf.SystemKey.Valid {
		return conflict("system shelves cannot be renamed, deleted, or converted")
	}
	return nil
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

func visibleShelfCount(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelf sqlc.Shelf) (int64, error) {
	if shelf.Mode == ShelfModeAutomatic {
		count, err := queries.ShelfAutomaticBookCount(ctx, sqlc.ShelfAutomaticBookCountParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, Rules: shelf.Rules.String,
		})
		if err != nil {
			return 0, fmt.Errorf("count automatic shelf books: %w", err)
		}
		return count, nil
	}
	count, err := queries.ShelfVisibleBookCount(ctx, sqlc.ShelfVisibleBookCountParams{
		ShelfID: shelf.ID, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return 0, fmt.Errorf("count visible shelf books: %w", err)
	}
	return count, nil
}

func shelfWithCount(ctx context.Context, queries *sqlc.Queries, viewer Viewer, row sqlc.Shelf) (Shelf, error) {
	count, err := visibleShelfCount(ctx, queries, viewer, row)
	if err != nil {
		return Shelf{}, err
	}
	return shelfDTO(row, count)
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

// ListShelves lists the viewer's system and private shelves plus shared shelves. Admins
// also see other accounts' custom private shelves, never their system shelves. System
// shelves sort first, then shelves by case-insensitive name and ID.
func (s *Service) ListShelves(ctx context.Context, viewer Viewer, options PageOptions) (Page[Shelf], error) {
	if err := checkViewer(viewer); err != nil {
		return Page[Shelf]{}, err
	}
	scope := viewerScope(viewer)
	limit, after, err := parsePage(options, "shelves", scope, "system,name")
	if err != nil {
		return Page[Shelf]{}, err
	}
	afterName, afterRank := "", int64(1)
	if after.ID != 0 {
		name, err := base64.RawURLEncoding.DecodeString(after.Text)
		if err != nil || len(name) == 0 || len(name) > 1024 || !utf8.Valid(name) {
			return Page[Shelf]{}, invalid("cursor is invalid")
		}
		afterName = string(name)
		if after.Null {
			afterRank = 0
		}
	}
	if _, err := s.ensureFavorites(ctx, viewer); err != nil {
		return Page[Shelf]{}, err
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) (Page[Shelf], error) {
		rows, err := queries.ShelfList(ctx, sqlc.ShelfListParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, AfterID: after.ID,
			AfterRank: afterRank, AfterName: afterName, PageSize: int64(limit + 1),
		})
		if err != nil {
			return Page[Shelf]{}, fmt.Errorf("list shelves: %w", err)
		}
		rows, next, err := paginate(rows, limit, func(row sqlc.Shelf) cursor {
			return cursor{
				Version: 1, Kind: "shelves", Scope: scope, Sort: "system,name", ID: row.ID,
				Text: base64.RawURLEncoding.EncodeToString([]byte(row.Name)), Null: row.SystemKey.Valid,
			}
		})
		if err != nil {
			return Page[Shelf]{}, err
		}
		items := make([]Shelf, 0, len(rows))
		for _, row := range rows {
			shelf, err := shelfWithCount(ctx, queries, viewer, row)
			if err != nil {
				return Page[Shelf]{}, err
			}
			items = append(items, shelf)
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
		return shelfWithCount(ctx, queries, viewer, row)
	})
}

// maximumBookShelves caps the shelves returned by ListBookShelves.
const maximumBookShelves = 200

// ListBookShelves returns the manual shelves visible to the viewer (as in ListShelves)
// that contain a visible book, sorted by case-insensitive name and ID. Automatic
// shelves and the virtual Unshelved view are excluded. A missing or invisible book
// is ErrNotFound.
func (s *Service) ListBookShelves(ctx context.Context, viewer Viewer, bookID int64) ([]Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return nil, err
	}
	if bookID < 1 {
		return nil, invalid("book ID is invalid")
	}
	return readSnapshot(ctx, s.reader, func(queries *sqlc.Queries) ([]Shelf, error) {
		if _, err := visibleBook(ctx, queries, viewer, bookID); err != nil {
			return nil, err
		}
		rows, err := queries.ShelfListContainingBook(ctx, sqlc.ShelfListContainingBookParams{
			IsAdmin: adminFlag(viewer), UserID: viewer.UserID, BookID: bookID,
			PageSize: maximumBookShelves,
		})
		if err != nil {
			return nil, fmt.Errorf("list book shelves: %w", err)
		}
		items := make([]Shelf, 0, len(rows))
		for _, row := range rows {
			shelf, err := shelfWithCount(ctx, queries, viewer, row)
			if err != nil {
				return nil, err
			}
			items = append(items, shelf)
		}
		return items, nil
	})
}

// CreateShelf creates a private shelf for the viewer, or a shared shelf for an admin.
// Automatic shelves must be private and are populated live from their rules.
func (s *Service) CreateShelf(ctx context.Context, viewer Viewer, input ShelfInput) (Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return Shelf{}, err
	}
	if input.Kind != "private" && input.Kind != "shared" {
		return Shelf{}, invalid("shelf kind must be private or shared")
	}
	if input.Mode == "" {
		input.Mode = ShelfModeManual
	}
	if input.Mode != ShelfModeManual && input.Mode != ShelfModeAutomatic {
		return Shelf{}, invalid("shelf mode must be manual or automatic")
	}
	if input.Kind == "shared" && !viewer.IsAdmin {
		return Shelf{}, ErrForbidden
	}
	rules := sql.NullString{}
	switch input.Mode {
	case ShelfModeManual:
		if input.Rules != nil {
			return Shelf{}, invalid("rules are only allowed on automatic shelves")
		}
	case ShelfModeAutomatic:
		if input.Kind != "private" {
			return Shelf{}, invalid("automatic shelves must be private")
		}
		if input.Rules == nil {
			return Shelf{}, invalid("automatic shelves require rules")
		}
		_, stored, err := normalizeRules(*input.Rules)
		if err != nil {
			return Shelf{}, err
		}
		rules = sql.NullString{String: stored, Valid: true}
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
			Mode: input.Mode, Rules: rules,
		})
		if err != nil {
			return fmt.Errorf("create shelf: %w", err)
		}
		result, err = shelfWithCount(ctx, queries, viewer, row)
		return err
	})
	return result, err
}

// UpdateShelf updates the name, description, and/or automatic rules of a shelf
// managed by the viewer. Mode conversion is rejected; system shelves only accept
// description changes.
func (s *Service) UpdateShelf(ctx context.Context, viewer Viewer, id int64, patch ShelfPatch) (Shelf, error) {
	if err := checkViewer(viewer); err != nil {
		return Shelf{}, err
	}
	if id < 1 || !patch.Name.Set && !patch.Description.Set && !patch.Mode.Set && !patch.Rules.Set {
		return Shelf{}, invalid("shelf ID and at least one update are required")
	}
	var name string
	var description, rules sql.NullString
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
	if patch.Mode.Set && (patch.Mode.Value == nil ||
		*patch.Mode.Value != ShelfModeManual && *patch.Mode.Value != ShelfModeAutomatic) {
		return Shelf{}, invalid("shelf mode must be manual or automatic")
	}
	if patch.Rules.Set {
		if patch.Rules.Value == nil {
			return Shelf{}, invalid("shelf rules cannot be null")
		}
		_, stored, err := normalizeRules(*patch.Rules.Value)
		if err != nil {
			return Shelf{}, err
		}
		rules = sql.NullString{String: stored, Valid: true}
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
		if row.SystemKey.Valid && (patch.Name.Set || patch.Mode.Set || patch.Rules.Set) {
			return checkShelfMutable(row)
		}
		if patch.Mode.Set && *patch.Mode.Value != row.Mode {
			return conflict("shelf mode cannot be changed after creation")
		}
		if patch.Rules.Set && row.Mode != ShelfModeAutomatic {
			return conflict("rules can only be changed on automatic shelves")
		}
		if !patch.Name.Set {
			name = row.Name
		}
		if !patch.Description.Set {
			description = row.Description
		}
		if !patch.Rules.Set {
			rules = row.Rules
		}
		if !row.SystemKey.Valid {
			if err := checkShelfName(ctx, queries, row, name); err != nil {
				return err
			}
		}
		updated, err := queries.ShelfUpdate(ctx, sqlc.ShelfUpdateParams{
			ID: id, Name: name, Description: description, Rules: rules, UpdatedAt: s.now().UnixMilli(),
		})
		if err != nil {
			return fmt.Errorf("update shelf: %w", err)
		}
		result, err = shelfWithCount(ctx, queries, viewer, updated)
		return err
	})
	return result, err
}

// DeleteShelf deletes a custom shelf managed by the viewer; system shelves are protected.
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
		if err := checkShelfMutable(row); err != nil {
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
