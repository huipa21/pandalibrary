package stats

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"pandalibrary/internal/db"
)

//go:embed books.sql
var booksQuery string

// Books aggregates the entire visible logical catalog in one read transaction.
// Genres use catalog tags, the repository's only genre/subject taxonomy.
// Separate books sharing bytes remain separate books; editions of one book
// contribute bytes individually but contribute only once to each format.
func (s *Service) Books(ctx context.Context, viewer Viewer, timezone string) (BooksResponse, error) {
	if viewer.UserID < 1 {
		return BooksResponse{}, fmt.Errorf("%w: viewer is invalid", ErrInvalid)
	}
	location, err := LoadTimezone(timezone)
	if err != nil {
		return BooksResponse{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	defer cancel()
	result := BooksResponse{
		Timezone: timezone, AddedOverTime: []BookBucket{}, PublicationYears: []BookBucket{},
		Genres: []BookBucket{}, Languages: []BookBucket{}, Formats: []BookBucket{},
		PageCounts: []BookBucket{}, TopAuthors: []RankedAuthor{},
		LargestBooks: []RankedBook{}, MostPages: []RankedBook{},
	}
	added, years, genres := map[string]int64{}, map[string]int64{}, map[string]int64{}
	languages, formats, pages, authors := map[string]int64{}, map[string]int64{}, map[string]int64{}, map[string]int64{}
	var admin int64
	if viewer.IsAdmin {
		admin = 1
	}
	err = db.WithTx(ctx, s.reader, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, booksQuery, sql.Named("user_id", viewer.UserID), sql.Named("is_admin", admin))
		if err != nil {
			return fmt.Errorf("query books stats: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var book RankedBook
			var created int64
			var published, language sql.NullString
			var pageCount, size sql.NullInt64
			var authorJSON, tagJSON, formatJSON string
			if err := rows.Scan(&book.BookID, &book.Title, &created, &published, &language, &pageCount,
				&size, &authorJSON, &tagJSON, &formatJSON); err != nil {
				return fmt.Errorf("scan books stats: %w", err)
			}
			book.Authors = []string{}
			var tags, bookFormats []string
			for _, item := range []struct {
				data string
				dest *[]string
			}{{authorJSON, &book.Authors}, {tagJSON, &tags}, {formatJSON, &bookFormats}} {
				if err := json.Unmarshal([]byte(item.data), item.dest); err != nil {
					return fmt.Errorf("decode books stats: %w", err)
				}
			}
			result.TotalBooks++
			added[time.UnixMilli(created).In(location).Format("2006-01")]++
			year := "unknown"
			if len(published.String) >= 4 {
				if number, err := strconv.Atoi(published.String[:4]); err == nil && number > 0 {
					year = published.String[:4]
				}
			}
			years[year]++
			lang := strings.TrimSpace(language.String)
			if lang == "" {
				lang = "unknown"
			}
			languages[lang]++
			incrementBookKeys(genres, tags)
			incrementBookKeys(formats, bookFormats)
			incrementBookKeys(authors, book.Authors)
			pages[pageBucket(pageCount)]++
			if size.Valid && size.Int64 > 0 {
				book.Value = size.Int64
				result.LargestBooks = append(result.LargestBooks, book)
			}
			if pageCount.Valid && pageCount.Int64 > 0 {
				book.Value = pageCount.Int64
				result.MostPages = append(result.MostPages, book)
			}
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read books stats: %w", err)
		}
		return ctx.Err()
	})
	if err != nil {
		return BooksResponse{}, err
	}
	result.AddedOverTime = bookBuckets(added)
	result.PublicationYears = bookBuckets(years)
	result.Genres = bookBuckets(genres)
	result.Languages = bookBuckets(languages)
	result.Formats = bookBuckets(formats)
	for _, key := range []string{"1-100", "101-200", "201-300", "301-500", "501-1000", "1001+", "unknown"} {
		result.PageCounts = append(result.PageCounts, BookBucket{Key: key, Count: pages[key]})
	}
	for name, count := range authors {
		result.TopAuthors = append(result.TopAuthors, RankedAuthor{Name: name, Count: count})
	}
	sort.Slice(result.TopAuthors, func(i, j int) bool {
		a, b := result.TopAuthors[i], result.TopAuthors[j]
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		return a.Name < b.Name
	})
	if len(result.TopAuthors) > 20 {
		result.TopAuthors = result.TopAuthors[:20]
	}
	result.LargestBooks = rankBooks(result.LargestBooks)
	result.MostPages = rankBooks(result.MostPages)
	return result, nil
}

func incrementBookKeys(counts map[string]int64, keys []string) {
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		if !seen[key] {
			counts[key]++
			seen[key] = true
		}
	}
}

func bookBuckets(counts map[string]int64) []BookBucket {
	result := make([]BookBucket, 0, len(counts))
	for key, count := range counts {
		result = append(result, BookBucket{Key: key, Count: count})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Key < result[j].Key })
	return result
}

func pageBucket(pages sql.NullInt64) string {
	if !pages.Valid || pages.Int64 < 1 {
		return "unknown"
	}
	for _, bucket := range []struct {
		max int64
		key string
	}{{100, "1-100"}, {200, "101-200"}, {300, "201-300"}, {500, "301-500"}, {1000, "501-1000"}} {
		if pages.Int64 <= bucket.max {
			return bucket.key
		}
	}
	return "1001+"
}

func rankBooks(books []RankedBook) []RankedBook {
	sort.Slice(books, func(i, j int) bool {
		if books[i].Value != books[j].Value {
			return books[i].Value > books[j].Value
		}
		return books[i].BookID < books[j].BookID
	})
	if len(books) > 20 {
		return books[:20]
	}
	return books
}
