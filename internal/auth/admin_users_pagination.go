package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"unicode/utf8"

	"pandalibrary/internal/db/sqlc"
)

// AdminUsersPage uses the same page shape and bounds as catalog lists.
type AdminUsersPage struct {
	Items      []AdminUser `json:"items"`
	NextCursor *string     `json:"next_cursor"`
}

type adminUsersCursor struct {
	Version  int    `json:"v"`
	Username string `json:"u"`
	ID       int64  `json:"i"`
}

// AdminListUsers orders case-insensitively by username, then ID.
func (s *Service) AdminListUsers(ctx context.Context, token string, limit int, cursor string) (AdminUsersPage, error) {
	queries := sqlc.New(s.reader)
	if _, err := s.checkAdmin(ctx, queries, token); err != nil {
		return AdminUsersPage{}, err
	}
	if limit == 0 {
		limit = 50
	}
	if limit < 1 || limit > 100 {
		return AdminUsersPage{}, fmt.Errorf("%w: limit must be between 1 and 100", ErrInvalidUser)
	}
	var after adminUsersCursor
	if cursor != "" {
		if len(cursor) > 1024 {
			return AdminUsersPage{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidUser)
		}
		raw, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil {
			return AdminUsersPage{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidUser)
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&after); err != nil {
			return AdminUsersPage{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidUser)
		}
		var extra any
		if err := decoder.Decode(&extra); err != io.EOF || after.Version != 1 || after.ID < 1 ||
			after.Username == "" || len(after.Username) > 64 || !utf8.ValidString(after.Username) {
			return AdminUsersPage{}, fmt.Errorf("%w: cursor is invalid", ErrInvalidUser)
		}
	}
	rows, err := queries.AdminListUsers(ctx, sqlc.AdminListUsersParams{
		AfterID: after.ID, AfterUsername: after.Username, PageLimit: int64(limit + 1),
	})
	if err != nil {
		return AdminUsersPage{}, fmt.Errorf("list managed users: %w", err)
	}
	page := AdminUsersPage{Items: make([]AdminUser, 0, min(len(rows), limit))}
	for index, row := range rows {
		if index == limit {
			last := page.Items[len(page.Items)-1]
			raw, err := json.Marshal(adminUsersCursor{Version: 1, Username: last.Username, ID: last.ID})
			if err != nil {
				return AdminUsersPage{}, fmt.Errorf("encode users cursor: %w", err)
			}
			next := base64.RawURLEncoding.EncodeToString(raw)
			page.NextCursor = &next
			break
		}
		page.Items = append(page.Items, adminUser(row))
	}
	return page, nil
}
