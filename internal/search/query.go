package search

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/db/sqlc"

	"golang.org/x/text/unicode/norm"
)

var ErrInvalid = errors.New("invalid search request")

const (
	defaultLimit   = 50
	maximumLimit   = 100
	maxQueryBytes  = 1024
	maxQueryTerms  = 32
	maxRawQueryLen = 4096
)

// Viewer is the trusted identity supplied by the authenticated HTTP layer.
type Viewer struct {
	UserID  int64
	IsAdmin bool
}

// PageOptions specifies a bounded search page and its opaque continuation cursor.
type PageOptions struct {
	Limit  int
	Cursor string
}

// Series describes the series associated with a search result.
type Series struct {
	ID    int64    `json:"id"`
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

// Result contains the visible metadata needed for a search result row.
type Result struct {
	ID       int64    `json:"id"`
	Title    string   `json:"title"`
	Authors  []string `json:"authors"`
	Series   *Series  `json:"series"`
	CoverURL *string  `json:"cover_url"`
	Rank     float64  `json:"rank"`
}

// Page is a search result page. Lower ranks are more relevant.
type Page struct {
	Items      []Result `json:"items"`
	NextCursor *string  `json:"next_cursor"`
}

// Service reads the existing catalog search index.
type Service struct {
	reader *sql.DB
}

// NewService constructs a search service over the database reader pool.
func NewService(reader *sql.DB) (*Service, error) {
	if reader == nil {
		return nil, errors.New("search requires a reader database")
	}
	return &Service{reader: reader}, nil
}

func invalid(detail string) error {
	return fmt.Errorf("%w: %s", ErrInvalid, detail)
}

type searchQuery struct {
	normalized string
	match      string
	patterns   string
}

func prepareQuery(raw string) (searchQuery, error) {
	if len(raw) > maxRawQueryLen || !utf8.ValidString(raw) {
		return searchQuery{}, invalid("query is invalid or too long")
	}
	for _, r := range raw {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return searchQuery{}, invalid("query contains an invalid control character")
		}
	}
	terms := strings.Fields(norm.NFKC.String(raw))
	normalized := strings.Join(terms, " ")
	if len(terms) == 0 || len(terms) > maxQueryTerms || len(normalized) > maxQueryBytes {
		return searchQuery{}, invalid("query is empty or too long")
	}

	matchTerms := make([]string, 0, len(terms))
	patterns := make([]string, 0, len(terms))
	escapeLike := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	for _, term := range terms {
		if utf8.RuneCountInString(term) >= 3 {
			matchTerms = append(matchTerms, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
		} else {
			patterns = append(patterns, "%"+escapeLike.Replace(term)+"%")
		}
	}
	encoded, err := json.Marshal(patterns)
	if err != nil {
		return searchQuery{}, fmt.Errorf("encode search patterns: %w", err)
	}
	return searchQuery{
		normalized: normalized,
		match:      strings.Join(matchTerms, " AND "),
		patterns:   string(encoded),
	}, nil
}

// Search returns one visibility-filtered page from a single SQLite read snapshot.
func (s *Service) Search(ctx context.Context, viewer Viewer, text string, options PageOptions) (Page, error) {
	if viewer.UserID < 1 {
		return Page{}, invalid("viewer is invalid")
	}
	query, err := prepareQuery(text)
	if err != nil {
		return Page{}, err
	}
	limit := options.Limit
	if limit == 0 {
		limit = defaultLimit
	}
	if limit < 1 || limit > maximumLimit {
		return Page{}, invalid("limit must be between 1 and 100")
	}
	after, err := parseCursor(options.Cursor, query.normalized, viewer)
	if err != nil {
		return Page{}, err
	}
	if query.match == "" && after.Rank != 0 {
		return Page{}, invalid("cursor does not match this search")
	}

	admin := int64(0)
	if viewer.IsAdmin {
		admin = 1
	}
	queries := sqlc.New(s.reader)
	var rows []sqlc.SearchBooksFTSRow
	if query.match != "" {
		rows, err = queries.SearchBooksFTS(ctx, sqlc.SearchBooksFTSParams{
			MatchQuery: query.match, IsAdmin: admin, UserID: viewer.UserID,
			Patterns: query.patterns, AfterID: after.ID, AfterScore: after.Rank,
			PageSize: int64(limit + 1),
		})
	} else {
		var matches []sqlc.SearchBooksLikeRow
		matches, err = queries.SearchBooksLike(ctx, sqlc.SearchBooksLikeParams{
			IsAdmin: admin, UserID: viewer.UserID, Patterns: query.patterns,
			AfterID: after.ID, PageSize: int64(limit + 1),
		})
		rows = make([]sqlc.SearchBooksFTSRow, 0, len(matches))
		for _, match := range matches {
			rows = append(rows, sqlc.SearchBooksFTSRow(match))
		}
	}
	if err != nil {
		return Page{}, fmt.Errorf("search books: %w", err)
	}

	result := Page{Items: make([]Result, 0, min(len(rows), limit))}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		next, err := encodeCursor(query.normalized, viewer, last.ID, last.Score)
		if err != nil {
			return Page{}, err
		}
		result.NextCursor = &next
	}
	for _, row := range rows {
		item, err := resultFromRow(row)
		if err != nil {
			return Page{}, err
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

func resultFromRow(row sqlc.SearchBooksFTSRow) (Result, error) {
	result := Result{ID: row.ID, Title: row.Title, Rank: row.Score}
	if math.IsNaN(row.Score) || math.IsInf(row.Score, 0) {
		return Result{}, errors.New("search returned a non-finite rank")
	}
	if err := json.Unmarshal([]byte(row.AuthorsJson), &result.Authors); err != nil {
		return Result{}, fmt.Errorf("decode search result authors for book %d: %w", row.ID, err)
	}
	if result.Authors == nil {
		return Result{}, fmt.Errorf("search result authors for book %d are not an array", row.ID)
	}
	if row.SeriesID.Valid != row.SeriesName.Valid {
		return Result{}, fmt.Errorf("search result for book %d has incomplete series metadata", row.ID)
	}
	if row.SeriesID.Valid {
		result.Series = &Series{ID: row.SeriesID.Int64, Name: row.SeriesName.String}
		if row.SeriesIndex.Valid {
			result.Series.Index = &row.SeriesIndex.Float64
		}
	}
	if row.CoverSha256.Valid {
		if !blobstore.ValidHash(row.CoverSha256.String) {
			return Result{}, fmt.Errorf("book %d has an invalid cover hash", row.ID)
		}
		url := fmt.Sprintf("/api/v1/books/%d/cover", row.ID)
		result.CoverURL = &url
	}
	return result, nil
}
