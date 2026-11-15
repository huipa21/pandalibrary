// Package wordbooks stores personal collections and independent dictionary snapshots.
package wordbooks

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/catalog"
	"pandalibrary/internal/dictionary"
)

const (
	MaxImportEntries = 10000
	MaxEntries       = 10000
)

type Wordbook struct {
	ID               int64    `json:"id"`
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Language         string   `json:"language"`
	MeaningLanguage  string   `json:"meaning_language"`
	MeaningLanguages []string `json:"meaning_languages"`
	CoverColor       string   `json:"cover_color"`
	CoverImage       string   `json:"cover_image"`
	EntryCount       int      `json:"entry_count"`
	BookCount        int      `json:"book_count"`
	IsDefault        bool     `json:"is_default"`
	Archived         bool     `json:"archived"`
	CreatedAt        string   `json:"created_at"`
	UpdatedAt        string   `json:"updated_at"`
}

type BookCreate struct {
	Name             string   `json:"name"`
	Description      string   `json:"description"`
	Language         string   `json:"language"`
	MeaningLanguage  string   `json:"meaning_language"`
	MeaningLanguages []string `json:"meaning_languages"`
	CoverColor       string   `json:"cover_color"`
	CoverImage       string   `json:"cover_image"`
}

type Source struct {
	BookID     *int64          `json:"book_id"`
	BookFileID *int64          `json:"book_file_id"`
	BookTitle  string          `json:"book_title"`
	Locator    json.RawMessage `json:"locator"`
	Fraction   float64         `json:"fraction"`
	Chapter    string          `json:"chapter,omitempty"`
}

func (s *Source) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"book_id", "book_file_id", "book_title", "locator", "fraction"} {
		value, ok := fields[key]
		if !ok || (key != "book_id" && key != "book_file_id" && bytes.Equal(value, []byte("null"))) {
			return invalid("source fields are required")
		}
		if value, ok := fields["chapter"]; ok && bytes.Equal(value, []byte("null")) {
			return invalid("source chapter must be a string")
		}
	}
	type plain Source
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*plain)(s))
}

type Entry struct {
	ID                int64              `json:"id"`
	WordbookID        int64              `json:"wordbook_id"`
	Kind              string             `json:"kind"`
	Text              string             `json:"text"`
	Definition        string             `json:"definition"`
	Note              string             `json:"note"`
	DictionaryEntries []dictionary.Entry `json:"dictionary_entries"`
	Source            Source             `json:"source"`
	CreatedAt         string             `json:"created_at"`
	UpdatedAt         string             `json:"updated_at"`
	DictionaryWarning string             `json:"dictionary_warning,omitempty"`
}

func (e *Entry) UnmarshalJSON(data []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"kind", "text", "definition", "note", "dictionary_entries", "source"} {
		value, ok := fields[key]
		if !ok || bytes.Equal(value, []byte("null")) {
			return invalid("import entry fields are required")
		}
		for _, key := range []string{"created_at", "updated_at"} {
			if value, ok := fields[key]; ok && bytes.Equal(value, []byte("null")) {
				return invalid("import timestamps must be strings")
			}
		}
	}
	type plain Entry
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	return decoder.Decode((*plain)(e))
}

type Capture struct {
	WordbookID        *int64              `json:"wordbook_id,omitempty"`
	Kind              string              `json:"kind"`
	Text              string              `json:"text"`
	Definition        string              `json:"definition"`
	Note              string              `json:"note"`
	Source            Source              `json:"source"`
	DictionaryEntries *[]dictionary.Entry `json:"dictionary_entries,omitempty"`
}

type BookPatch struct {
	Name             *string   `json:"name"`
	Archived         *bool     `json:"archived"`
	Description      *string   `json:"description"`
	Language         *string   `json:"language"`
	MeaningLanguage  *string   `json:"meaning_language"`
	MeaningLanguages *[]string `json:"meaning_languages"`
	CoverColor       *string   `json:"cover_color"`
	CoverImage       *string   `json:"cover_image"`
}

type EntryPatch struct {
	Text       *string `json:"text"`
	Definition *string `json:"definition"`
	Note       *string `json:"note"`
}

type Export struct {
	Version  int `json:"version"`
	Wordbook struct {
		Name string `json:"name"`
	} `json:"wordbook"`
	Entries []Entry `json:"entries"`
}

type Dictionary interface {
	Status(context.Context) (dictionary.Status, error)
	Lookup(context.Context, dictionary.Query) (dictionary.Result, error)
}

type Catalog interface {
	GetBook(context.Context, catalog.Viewer, int64) (catalog.Book, error)
}

type Service struct {
	writer     *sql.DB
	catalog    Catalog
	dictionary Dictionary
	logger     *slog.Logger
}

func NewService(writer *sql.DB, books Catalog, dictionaries Dictionary, logger *slog.Logger) *Service {
	return &Service{writer: writer, catalog: books, dictionary: dictionaries, logger: logger}
}

func invalid(message string) error { return fmt.Errorf("%w: %s", catalog.ErrInvalid, message) }
func now() string                  { return time.Now().UTC().Format(time.RFC3339Nano) }

type scanner interface{ Scan(...any) error }

func scanBook(row scanner) (b Wordbook, err error) {
	var languages string
	err = row.Scan(&b.ID, &b.Name, &b.IsDefault, &b.Archived, &b.CreatedAt, &b.UpdatedAt, &b.Description, &b.Language, &b.MeaningLanguage, &languages, &b.CoverColor, &b.CoverImage, &b.EntryCount, &b.BookCount)
	if errors.Is(err, sql.ErrNoRows) {
		err = catalog.ErrNotFound
	}
	if err == nil {
		err = json.Unmarshal([]byte(languages), &b.MeaningLanguages)
	}
	return
}

// Counts are correlated subqueries so a single list query returns them without per-book round trips.
const bookColumns = `id, name, is_default, archived, created_at, updated_at, description, language, meaning_language, meaning_languages, cover_color, cover_image,
	(SELECT count(*) FROM wordbook_entries e WHERE e.wordbook_id = wordbooks.id),
	(SELECT count(DISTINCT json_extract(e.source, '$.book_id')) FROM wordbook_entries e WHERE e.wordbook_id = wordbooks.id)`

func getBook(ctx context.Context, tx *sql.Tx, userID, id int64) (Wordbook, error) {
	return scanBook(tx.QueryRowContext(ctx, "SELECT "+bookColumns+" FROM wordbooks WHERE user_id = ? AND id = ? AND deleted_at IS NULL", userID, id))
}

func defaultBook(ctx context.Context, tx *sql.Tx, userID int64) (Wordbook, error) {
	stamp := now()
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO wordbooks(user_id, name, is_default, created_at, updated_at) VALUES (?, 'Default', 1, ?, ?)`, userID, stamp, stamp); err != nil {
		return Wordbook{}, err
	}
	return scanBook(tx.QueryRowContext(ctx, "SELECT "+bookColumns+" FROM wordbooks WHERE user_id = ? AND is_default = 1", userID))
}

func (s *Service) List(ctx context.Context, userID int64) ([]Wordbook, error) {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = defaultBook(ctx, tx, userID); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT "+bookColumns+" FROM wordbooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY is_default DESC, id", userID)
	if err != nil {
		return nil, err
	}
	books := []Wordbook{}
	for rows.Next() {
		b, err := scanBook(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		books = append(books, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return books, tx.Commit()
}

func validString(value string, max int) bool {
	return utf8.ValidString(value) && !strings.ContainsRune(value, 0) && utf8.RuneCountInString(value) <= max
}

func validName(name string) bool { return strings.TrimSpace(name) != "" && validString(name, 200) }

func validDescription(description string) bool { return validString(description, 2000) }

var languagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`)

func validLanguage(language string) bool {
	return language == "" || len(language) <= 35 && languagePattern.MatchString(language)
}

func normalizeMeaningLanguages(legacy string, languages []string) (string, []string, error) {
	legacy = strings.TrimSpace(legacy)
	if !validLanguage(legacy) {
		return "", nil, invalid("meaning_language must be a BCP 47 language tag")
	}
	if languages == nil {
		languages = []string{}
		if legacy != "" {
			languages = append(languages, legacy)
		}
	}
	if len(languages) > 20 {
		return "", nil, invalid("meaning_languages must contain at most 20 language tags")
	}
	result := []string{}
	seen := map[string]bool{}
	for _, language := range languages {
		language = strings.TrimSpace(language)
		if language == "" || !validLanguage(language) {
			return "", nil, invalid("meaning_languages must contain BCP 47 language tags")
		}
		key := strings.ToLower(language)
		if !seen[key] {
			result = append(result, language)
			seen[key] = true
		}
	}
	legacy = ""
	if len(result) > 0 {
		legacy = result[0]
	}
	return legacy, result, nil
}

func (s *Service) Create(ctx context.Context, userID int64, name string) (Wordbook, error) {
	return s.CreateWithDescription(ctx, userID, BookCreate{Name: name})
}

func (s *Service) CreateWithDescription(ctx context.Context, userID int64, input BookCreate) (Wordbook, error) {
	name := strings.TrimSpace(input.Name)
	if !validName(name) {
		return Wordbook{}, invalid("name must contain 1 to 200 characters")
	}
	description := strings.TrimSpace(input.Description)
	if !validDescription(description) {
		return Wordbook{}, invalid("description must contain at most 2000 characters")
	}
	language := strings.TrimSpace(input.Language)
	if !validLanguage(language) {
		return Wordbook{}, invalid("language must be a BCP 47 language tag")
	}
	meaningLanguage, meaningLanguages, err := normalizeMeaningLanguages(input.MeaningLanguage, input.MeaningLanguages)
	if err != nil {
		return Wordbook{}, err
	}
	if err := validateCover(input.CoverColor, input.CoverImage); err != nil {
		return Wordbook{}, err
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return Wordbook{}, err
	}
	defer tx.Rollback()
	if _, err = defaultBook(ctx, tx, userID); err != nil {
		return Wordbook{}, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM wordbooks WHERE user_id = ?", userID).Scan(&count); err != nil {
		return Wordbook{}, err
	}
	if count >= 1000 {
		return Wordbook{}, invalid("wordbook limit reached")
	}
	stamp := now()
	languagesJSON, _ := json.Marshal(meaningLanguages)
	result, err := tx.ExecContext(ctx, "INSERT INTO wordbooks(user_id, name, description, language, meaning_language, meaning_languages, cover_color, cover_image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", userID, name, description, language, meaningLanguage, string(languagesJSON), input.CoverColor, input.CoverImage, stamp, stamp)
	if err != nil {
		return Wordbook{}, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return Wordbook{}, err
	}
	b, err := getBook(ctx, tx, userID, id)
	if err != nil {
		return Wordbook{}, err
	}
	return b, tx.Commit()
}

func (s *Service) PatchBook(ctx context.Context, userID, id int64, patch BookPatch) (Wordbook, error) {
	if patch.Name == nil && patch.Archived == nil && patch.Description == nil && patch.Language == nil && patch.MeaningLanguage == nil && patch.MeaningLanguages == nil && patch.CoverColor == nil && patch.CoverImage == nil {
		return Wordbook{}, invalid("no changes supplied")
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return Wordbook{}, err
	}
	defer tx.Rollback()
	b, err := getBook(ctx, tx, userID, id)
	if err != nil {
		return Wordbook{}, err
	}
	if patch.Name != nil {
		b.Name = strings.TrimSpace(*patch.Name)
		if !validName(b.Name) {
			return Wordbook{}, invalid("name must contain 1 to 200 characters")
		}
	}
	if patch.Archived != nil {
		b.Archived = *patch.Archived
	}
	if patch.Description != nil {
		b.Description = strings.TrimSpace(*patch.Description)
		if !validDescription(b.Description) {
			return Wordbook{}, invalid("description must contain at most 2000 characters")
		}
	}
	if patch.Language != nil {
		b.Language = strings.TrimSpace(*patch.Language)
		if !validLanguage(b.Language) {
			return Wordbook{}, invalid("language must be a BCP 47 language tag")
		}
	}
	if patch.MeaningLanguage != nil || patch.MeaningLanguages != nil {
		legacy := ""
		if patch.MeaningLanguage != nil {
			legacy = *patch.MeaningLanguage
		}
		var languages []string
		if patch.MeaningLanguages != nil {
			languages = *patch.MeaningLanguages
		}
		b.MeaningLanguage, b.MeaningLanguages, err = normalizeMeaningLanguages(legacy, languages)
		if err != nil {
			return Wordbook{}, err
		}
	}
	if b.IsDefault && b.Archived {
		return Wordbook{}, invalid("the default wordbook cannot be archived")
	}
	if patch.CoverColor != nil {
		b.CoverColor = *patch.CoverColor
	}
	if patch.CoverImage != nil {
		b.CoverImage = *patch.CoverImage
	}
	if err := validateCover(b.CoverColor, b.CoverImage); err != nil {
		return Wordbook{}, err
	}
	b.UpdatedAt = now()
	languagesJSON, _ := json.Marshal(b.MeaningLanguages)
	if _, err = tx.ExecContext(ctx, "UPDATE wordbooks SET name = ?, description = ?, language = ?, meaning_language = ?, meaning_languages = ?, cover_color = ?, cover_image = ?, archived = ?, updated_at = ? WHERE id = ? AND user_id = ?", b.Name, b.Description, b.Language, b.MeaningLanguage, string(languagesJSON), b.CoverColor, b.CoverImage, b.Archived, b.UpdatedAt, b.ID, userID); err != nil {
		return Wordbook{}, err
	}
	return b, tx.Commit()
}

// BookWords returns the viewer's own entries captured from a catalog book the viewer can see.
func (s *Service) BookWords(ctx context.Context, viewer catalog.Viewer, bookID int64) ([]Entry, error) {
	if _, err := s.catalog.GetBook(ctx, viewer, bookID); err != nil {
		return nil, err
	}
	rows, err := s.writer.QueryContext(ctx, "SELECT "+entryColumns+` FROM wordbook_entries
		WHERE json_extract(source, '$.book_id') = ? AND wordbook_id IN (SELECT id FROM wordbooks WHERE user_id = ? AND deleted_at IS NULL)
		ORDER BY id`, bookID, viewer.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func validateEntry(e *Entry) error {
	switch e.Kind {
	case "word", "phrase":
	case "sentence", "passage":
		if e.Definition != "" {
			return invalid("sentence and passage definitions must be empty")
		}
	default:
		return invalid("kind must be word, phrase, sentence or passage")
	}
	if strings.TrimSpace(e.Text) == "" || !validString(e.Text, 100000) {
		return invalid("text must contain 1 to 100000 characters")
	}
	if !validString(e.Definition, 100000) || !validString(e.Note, 100000) {
		return invalid("definition or note is too long")
	}
	src := e.Source
	if (src.BookID != nil && *src.BookID < 1) || (src.BookFileID != nil && (*src.BookFileID < 1 || src.BookID == nil)) {
		return invalid("source IDs are invalid")
	}
	if !validString(src.BookTitle, 2000) || !validString(src.Chapter, 2000) || math.IsNaN(src.Fraction) || math.IsInf(src.Fraction, 0) || src.Fraction < 0 || src.Fraction > 1 {
		return invalid("source metadata is invalid")
	}
	if len(src.Locator) == 0 || len(src.Locator) > 65536 || !json.Valid(src.Locator) || bytes.Equal(bytes.TrimSpace(src.Locator), []byte("null")) {
		return invalid("source locator is invalid")
	}
	if e.DictionaryEntries == nil {
		e.DictionaryEntries = []dictionary.Entry{}
	}
	if len(e.DictionaryEntries) > 100 {
		return invalid("too many dictionary entries")
	}
	for _, d := range e.DictionaryEntries {
		if d.Source == "" || d.Headword == "" || !validString(d.Source, 200) || !validString(d.SourceName, 1000) || !validString(d.Headword, 2000) || !validString(d.Reading, 2000) || !validString(d.PartOfSpeech, 1000) || len(d.Definitions) > 100 {
			return invalid("dictionary entry is invalid")
		}
		if !validLanguage(string(d.From)) || !validLanguage(string(d.To)) {
			return invalid("dictionary direction is invalid")
		}
		if d.Match != dictionary.MatchExact && d.Match != dictionary.MatchLemma && d.Match != dictionary.MatchPrefix {
			return invalid("dictionary match is invalid")
		}
		if d.Definitions == nil {
			return invalid("dictionary definitions must be an array")
		}
		for _, definition := range d.Definitions {
			if !validString(definition, 100000) {
				return invalid("dictionary definition is too long")
			}
		}
	}
	data, err := json.Marshal(e.DictionaryEntries)
	if err != nil || len(data) > 262144 {
		return invalid("dictionary snapshot is too large")
	}
	return nil
}

func (s *Service) enrich(ctx context.Context, e *Entry) {
	if s.dictionary == nil || (e.Kind != "word" && e.Kind != "phrase") || utf8.RuneCountInString(e.Text) > dictionary.MaxQueryRunes {
		return
	}
	warn := func(err error) {
		s.logger.ErrorContext(ctx, "wordbook dictionary enrichment failed", "error", err)
		e.DictionaryWarning = "Dictionary lookup failed; the selection was saved without a complete dictionary snapshot."
	}
	status, err := s.dictionary.Status(ctx)
	if err != nil {
		warn(err)
		return
	}
	directions := map[string]bool{}
	entries := map[string]bool{}
	for _, direction := range status.Directions {
		key := string(direction.From) + ":" + string(direction.To)
		if directions[key] {
			continue
		}
		directions[key] = true
		result, err := s.dictionary.Lookup(ctx, dictionary.Query{Text: e.Text, From: direction.From, To: direction.To, Limit: dictionary.MaxLimit})
		if err != nil {
			warn(err)
			continue
		}
		for _, entry := range result.Entries {
			entry.From, entry.To = direction.From, direction.To
			if entry.Definitions == nil {
				entry.Definitions = []string{}
			}
			// Match paths may repeat the same source/headword/reading snapshot.
			data, _ := json.Marshal(struct {
				Source, Headword, Reading, PartOfSpeech string
				From, To                                dictionary.Lang
				Definitions                             []string
			}{entry.Source, entry.Headword, entry.Reading, entry.PartOfSpeech, entry.From, entry.To, entry.Definitions})
			key := string(data)
			if !entries[key] && len(e.DictionaryEntries) < 100 {
				entries[key] = true
				e.DictionaryEntries = append(e.DictionaryEntries, entry)
			}
		}
	}
	if err := validateEntry(e); err != nil {
		e.DictionaryEntries = []dictionary.Entry{}
		warn(err)
	}
}

func (s *Service) Capture(ctx context.Context, viewer catalog.Viewer, input Capture) (Entry, error) {
	e := Entry{Kind: input.Kind, Text: input.Text, Definition: input.Definition, Note: input.Note, Source: input.Source}
	if input.DictionaryEntries != nil {
		e.DictionaryEntries = *input.DictionaryEntries
	}
	if err := validateEntry(&e); err != nil {
		return Entry{}, err
	}
	if input.WordbookID != nil && *input.WordbookID < 1 {
		return Entry{}, invalid("wordbook ID is invalid")
	}
	// Never dereference imported sources. Live captures alone consult visible catalog metadata.
	if e.Source.BookID != nil {
		book, err := s.catalog.GetBook(ctx, viewer, *e.Source.BookID)
		if err != nil {
			return Entry{}, err
		}
		if e.Source.BookFileID != nil {
			found := false
			for _, file := range book.Files {
				if file.ID == *e.Source.BookFileID {
					found = true
				}
			}
			if !found {
				return Entry{}, catalog.ErrNotFound
			}
		}
		e.Source.BookTitle = book.Title
	}
	// Check ownership before dictionary work, but do not hold the writer during lookup.
	if input.WordbookID != nil {
		b, err := scanBook(s.writer.QueryRowContext(ctx, "SELECT "+bookColumns+" FROM wordbooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL", *input.WordbookID, viewer.UserID))
		if err != nil {
			return Entry{}, err
		}
		if b.Archived {
			return Entry{}, invalid("cannot collect into an archived wordbook")
		}
	}
	if input.DictionaryEntries == nil || len(*input.DictionaryEntries) == 0 {
		s.enrich(ctx, &e)
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return Entry{}, err
	}
	defer tx.Rollback()
	var b Wordbook
	if input.WordbookID == nil {
		b, err = defaultBook(ctx, tx, viewer.UserID)
	} else {
		b, err = getBook(ctx, tx, viewer.UserID, *input.WordbookID)
	}
	if err != nil {
		return Entry{}, err
	}
	if b.Archived {
		return Entry{}, invalid("cannot collect into an archived wordbook")
	}
	if err = capacity(ctx, tx, b.ID, 1); err != nil {
		return Entry{}, err
	}
	e.WordbookID = b.ID
	if err = insertEntry(ctx, tx, &e); err != nil {
		return Entry{}, err
	}
	return e, tx.Commit()
}

func capacity(ctx context.Context, tx *sql.Tx, bookID int64, added int) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM wordbook_entries WHERE wordbook_id = ?", bookID).Scan(&count); err != nil {
		return err
	}
	if count+added > MaxEntries {
		return invalid("wordbook entry limit reached")
	}
	return nil
}

func insertEntry(ctx context.Context, tx *sql.Tx, e *Entry) error {
	dictionaries, err := json.Marshal(e.DictionaryEntries)
	if err != nil {
		return err
	}
	source, err := json.Marshal(e.Source)
	if err != nil {
		return err
	}
	stamp := now()
	if e.CreatedAt == "" {
		e.CreatedAt = stamp
	}
	if e.UpdatedAt == "" {
		e.UpdatedAt = stamp
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO wordbook_entries(wordbook_id, kind, text, definition, note, dictionary_entries, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.WordbookID, e.Kind, e.Text, e.Definition, e.Note, string(dictionaries), string(source), e.CreatedAt, e.UpdatedAt)
	if err != nil {
		return err
	}
	e.ID, err = result.LastInsertId()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE wordbooks SET updated_at = ? WHERE id = ?", stamp, e.WordbookID)
	return err
}

const entryColumns = "id, wordbook_id, kind, text, definition, note, dictionary_entries, source, created_at, updated_at"

func scanEntry(row scanner) (e Entry, err error) {
	var dictionaries, source string
	err = row.Scan(&e.ID, &e.WordbookID, &e.Kind, &e.Text, &e.Definition, &e.Note, &dictionaries, &source, &e.CreatedAt, &e.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return e, catalog.ErrNotFound
	}
	if err != nil {
		return
	}
	if err = json.Unmarshal([]byte(dictionaries), &e.DictionaryEntries); err != nil {
		return
	}
	err = json.Unmarshal([]byte(source), &e.Source)
	return
}

func (s *Service) Export(ctx context.Context, userID, id int64) (Export, error) {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return Export{}, err
	}
	defer tx.Rollback()
	b, err := getBook(ctx, tx, userID, id)
	if err != nil {
		return Export{}, err
	}
	result := Export{Version: 1, Entries: []Entry{}}
	result.Wordbook.Name = b.Name
	rows, err := tx.QueryContext(ctx, "SELECT "+entryColumns+" FROM wordbook_entries WHERE wordbook_id = ? ORDER BY id", id)
	if err != nil {
		return Export{}, err
	}
	for rows.Next() {
		e, err := scanEntry(rows)
		if err != nil {
			rows.Close()
			return Export{}, err
		}
		result.Entries = append(result.Entries, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return Export{}, err
	}
	return result, tx.Commit()
}

func (s *Service) Import(ctx context.Context, userID, id int64, input Export) (int, error) {
	if input.Version != 1 || !validName(input.Wordbook.Name) || input.Entries == nil || len(input.Entries) > MaxImportEntries {
		return 0, invalid("invalid version, wordbook name or import entry count")
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	b, err := getBook(ctx, tx, userID, id)
	if err != nil {
		return 0, err
	}
	if b.Archived {
		return 0, invalid("cannot import into an archived wordbook")
	}
	if err = capacity(ctx, tx, id, len(input.Entries)); err != nil {
		return 0, err
	}
	for _, e := range input.Entries {
		if err = validateEntry(&e); err != nil {
			return 0, err
		}
		if err = importTimestamps(&e); err != nil {
			return 0, err
		}
		e.WordbookID = id
		e.DictionaryWarning = ""
		if err = insertEntry(ctx, tx, &e); err != nil {
			return 0, err
		}
	}
	return len(input.Entries), tx.Commit()
}

func importTimestamps(e *Entry) error {
	stamp := now()
	if e.CreatedAt == "" {
		e.CreatedAt = stamp
	}
	if e.UpdatedAt == "" {
		e.UpdatedAt = stamp
	}
	created, createdErr := time.Parse(time.RFC3339Nano, e.CreatedAt)
	updated, updatedErr := time.Parse(time.RFC3339Nano, e.UpdatedAt)
	if createdErr != nil || updatedErr != nil ||
		created.UTC().Format(time.RFC3339Nano) != e.CreatedAt ||
		updated.UTC().Format(time.RFC3339Nano) != e.UpdatedAt ||
		updated.Before(created) {
		return invalid("import timestamps must be canonical UTC RFC3339 dates with updated_at >= created_at")
	}
	return nil
}

func (s *Service) PatchEntry(ctx context.Context, userID, bookID, entryID int64, patch EntryPatch) (Entry, error) {
	if patch.Text == nil && patch.Definition == nil && patch.Note == nil {
		return Entry{}, invalid("no changes supplied")
	}
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return Entry{}, err
	}
	defer tx.Rollback()
	if _, err = getBook(ctx, tx, userID, bookID); err != nil {
		return Entry{}, err
	}
	e, err := scanEntry(tx.QueryRowContext(ctx, "SELECT "+entryColumns+" FROM wordbook_entries WHERE wordbook_id = ? AND id = ?", bookID, entryID))
	if err != nil {
		return Entry{}, err
	}
	if patch.Text != nil {
		e.Text = *patch.Text
	}
	if patch.Definition != nil {
		e.Definition = *patch.Definition
	}
	if patch.Note != nil {
		e.Note = *patch.Note
	}
	if err = validateEntry(&e); err != nil {
		return Entry{}, err
	}
	e.UpdatedAt = now()
	if _, err = tx.ExecContext(ctx, "UPDATE wordbook_entries SET text = ?, definition = ?, note = ?, updated_at = ? WHERE id = ?", e.Text, e.Definition, e.Note, e.UpdatedAt, e.ID); err != nil {
		return Entry{}, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE wordbooks SET updated_at = ? WHERE id = ?", e.UpdatedAt, bookID); err != nil {
		return Entry{}, err
	}
	return e, tx.Commit()
}

func (s *Service) DeleteEntry(ctx context.Context, userID, bookID, entryID int64) error {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}

	defer tx.Rollback()
	if _, err = getBook(ctx, tx, userID, bookID); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM wordbook_entries WHERE wordbook_id = ? AND id = ?", bookID, entryID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return catalog.ErrNotFound
	}
	if _, err = tx.ExecContext(ctx, "UPDATE wordbooks SET updated_at = ? WHERE id = ?", now(), bookID); err != nil {
		return err
	}
	return tx.Commit()
}

// Delete moves a wordbook and its entries to the trash.
func (s *Service) Delete(ctx context.Context, userID, id int64) error {
	return s.DeleteWithMerge(ctx, userID, id, nil)
}

// DeleteWithMerge optionally moves entries before putting the wordbook in trash.
func (s *Service) DeleteWithMerge(ctx context.Context, userID, id int64, mergeIntoID *int64) error {
	tx, err := s.writer.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	book, err := getBook(ctx, tx, userID, id)
	if err != nil {
		return err
	}
	var remaining int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM wordbooks WHERE user_id = ? AND id != ? AND deleted_at IS NULL`, userID, id).Scan(&remaining); err != nil {
		return err
	}
	if remaining == 0 {
		return fmt.Errorf("%w: the last wordbook cannot be deleted", catalog.ErrConflict)
	}
	if mergeIntoID != nil {
		if *mergeIntoID < 1 || *mergeIntoID == id {
			return invalid("invalid merge target")
		}
		target, err := getBook(ctx, tx, userID, *mergeIntoID)
		if err != nil {
			return err
		}
		if target.Archived {
			return invalid("cannot merge into an archived wordbook")
		}
		if err := capacity(ctx, tx, target.ID, book.EntryCount); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE wordbook_entries SET wordbook_id = ? WHERE wordbook_id = ?`, target.ID, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE wordbooks SET updated_at = ? WHERE id = ?`, now(), target.ID); err != nil {
			return err
		}
	}
	if book.IsDefault {
		var targetID int64
		if mergeIntoID != nil {
			targetID = *mergeIntoID
		} else if err := tx.QueryRowContext(ctx, `SELECT id FROM wordbooks WHERE user_id = ? AND id != ? AND deleted_at IS NULL ORDER BY archived, id LIMIT 1`, userID, id).Scan(&targetID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE wordbooks SET is_default = 0 WHERE id = ?`, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE wordbooks SET is_default = 1, archived = 0, updated_at = ? WHERE id = ?`, now(), targetID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE wordbooks SET deleted_at = ? WHERE id = ? AND user_id = ?`, time.Now().UTC().UnixMilli(), id, userID); err != nil {
		return err
	}
	return tx.Commit()
}
