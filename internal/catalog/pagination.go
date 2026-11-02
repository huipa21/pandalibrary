package catalog

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
)

const (
	defaultPageSize = 50
	maximumPageSize = 100
	maxCursorBytes  = 4096
)

type cursor struct {
	Version int     `json:"v"`
	Kind    string  `json:"k"`
	Scope   string  `json:"s"`
	Sort    string  `json:"o,omitempty"`
	ID      int64   `json:"i"`
	Text    string  `json:"t,omitempty"`
	Time    int64   `json:"d,omitempty"`
	Index   float64 `json:"x,omitempty"`
	Null    bool    `json:"z,omitempty"`
}

func viewerScope(viewer Viewer) string {
	return fmt.Sprintf("%d:%t", viewer.UserID, viewer.IsAdmin)
}

func parsePage(options PageOptions, kind, scope, sort string) (int, cursor, error) {
	limit := options.Limit
	if limit == 0 {
		limit = defaultPageSize
	}
	if limit < 1 || limit > maximumPageSize {
		return 0, cursor{}, invalid("limit must be between 1 and 100")
	}
	if options.Cursor == "" {
		return limit, cursor{Version: 1, Kind: kind, Scope: scope, Sort: sort}, nil
	}
	if len(options.Cursor) > maxCursorBytes {
		return 0, cursor{}, invalid("cursor is invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(options.Cursor)
	if err != nil || len(raw) > maxCursorBytes {
		return 0, cursor{}, invalid("cursor is invalid")
	}
	var result cursor
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return 0, cursor{}, invalid("cursor is invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || result.Version != 1 ||
		result.Kind != kind || result.Scope != scope || result.Sort != sort ||
		result.ID < 1 || math.IsNaN(result.Index) || math.IsInf(result.Index, 0) {
		return 0, cursor{}, invalid("cursor does not match this list")
	}
	return limit, result, nil
}

func paginate[T any](items []T, limit int, next func(T) cursor) ([]T, *string, error) {
	if len(items) <= limit {
		return items, nil, nil
	}
	items = items[:limit]
	encoded, err := json.Marshal(next(items[len(items)-1]))
	if err != nil {
		return nil, nil, fmt.Errorf("encode catalog cursor: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(encoded)
	return items, &token, nil
}
