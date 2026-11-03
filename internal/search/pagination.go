package search

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
)

const maxCursorBytes = 4096

type cursor struct {
	Version int     `json:"v"`
	Query   string  `json:"q"`
	UserID  int64   `json:"u"`
	Admin   bool    `json:"a"`
	ID      int64   `json:"i"`
	Rank    float64 `json:"r"`
}

type cursorEnvelope struct {
	Version *int     `json:"v"`
	Query   *string  `json:"q"`
	UserID  *int64   `json:"u"`
	Admin   *bool    `json:"a"`
	ID      *int64   `json:"i"`
	Rank    *float64 `json:"r"`
}

func queryFingerprint(query string) string {
	sum := sha256.Sum256([]byte(query))
	return hex.EncodeToString(sum[:])
}

func parseCursor(token, query string, viewer Viewer) (cursor, error) {
	if token == "" {
		return cursor{}, nil
	}
	if len(token) > maxCursorBytes {
		return cursor{}, invalid("cursor is invalid")
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) > maxCursorBytes {
		return cursor{}, invalid("cursor is invalid")
	}
	var decoded cursorEnvelope
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return cursor{}, invalid("cursor is invalid")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF || decoded.Version == nil ||
		decoded.Query == nil || decoded.UserID == nil || decoded.Admin == nil ||
		decoded.ID == nil || decoded.Rank == nil {
		return cursor{}, invalid("cursor is invalid")
	}
	result := cursor{
		Version: *decoded.Version, Query: *decoded.Query, UserID: *decoded.UserID,
		Admin: *decoded.Admin, ID: *decoded.ID, Rank: *decoded.Rank,
	}
	if result.Version != 1 || result.Query != queryFingerprint(query) ||
		result.UserID != viewer.UserID || result.Admin != viewer.IsAdmin ||
		result.ID < 1 || math.IsNaN(result.Rank) || math.IsInf(result.Rank, 0) {
		return cursor{}, invalid("cursor does not match this search")
	}
	return result, nil
}

func encodeCursor(query string, viewer Viewer, id int64, rank float64) (string, error) {
	data, err := json.Marshal(cursor{
		Version: 1, Query: queryFingerprint(query), UserID: viewer.UserID,
		Admin: viewer.IsAdmin, ID: id, Rank: rank,
	})
	if err != nil {
		return "", fmt.Errorf("encode search cursor: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
