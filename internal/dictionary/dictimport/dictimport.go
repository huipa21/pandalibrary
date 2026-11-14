// Package dictimport loads dictionary source files into the dictionary database.
//
// An import replaces every row of its source. The old rows are deleted in the
// same transaction as the first batch of new rows and the remaining rows are
// committed in batches of BatchSize entries, so readers see the source missing
// or partially loaded while a large import runs. If an import fails before its
// first commit the old rows stay untouched; if it fails later the partial rows
// of that source are removed again (best effort) and the source has to be
// imported again.
package dictimport

import (
	"bufio"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/dictionary"
)

// BatchSize is the number of entries committed per transaction.
const BatchSize = 50_000

// Options tunes an import.
type Options struct {
	// Progress is called after each committed batch with the number of entries stored so far.
	Progress func(entries int64)
	// Warn receives non-fatal problems such as a missing Traditional→Simplified table.
	Warn func(message string)
}

// Import replaces sourceID in the database at dbPath with the entries read from input.
// Gzip-compressed input is detected by its magic bytes. It returns the number of stored entries.
func Import(ctx context.Context, dbPath, sourceID string, input io.Reader, options Options) (int64, error) {
	spec, _, ok := dictionary.SourceByID(sourceID)
	if !ok {
		return 0, fmt.Errorf("unknown dictionary source %q", sourceID)
	}
	parse, err := parserFor(sourceID)
	if err != nil {
		return 0, err
	}
	reader, closeReader, err := decompress(input)
	if err != nil {
		return 0, err
	}
	defer closeReader()

	database, err := dictionary.Open(ctx, dbPath, true)
	if err != nil {
		return 0, err
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, `PRAGMA cache_size = -131072`); err != nil {
		return 0, fmt.Errorf("configure dictionary database: %w", err)
	}
	simplifier, err := dictionary.LoadSimplifier(ctx, database)
	if err != nil {
		return 0, err
	}
	w := &writer{
		ctx:        ctx,
		db:         database,
		spec:       spec,
		simplifier: simplifier,
		options:    options,
		seenKeys:   map[string]struct{}{},
	}
	if err := parse(ctx, reader, w); err != nil {
		return 0, errors.Join(err, w.abort())
	}
	if err := w.finish(); err != nil {
		return 0, errors.Join(err, w.abort())
	}
	return w.total, nil
}

// ImportFile imports the file at filePath and reports progress and warnings to out.
func ImportFile(ctx context.Context, dbPath, sourceID, filePath string, out io.Writer) (int64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return 0, err
	}
	defer file.Close()
	if out == nil {
		out = io.Discard
	}
	started := time.Now()
	return Import(ctx, dbPath, sourceID, file, Options{
		Progress: func(entries int64) {
			fmt.Fprintf(out, "%s: %d entries (%s)\n", sourceID, entries, time.Since(started).Round(time.Second))
		},
		Warn: func(message string) {
			fmt.Fprintf(out, "warning: %s\n", message)
		},
	})
}

// List returns the imported sources in registry order. A missing database yields an empty list.
func List(ctx context.Context, dbPath string) ([]dictionary.SourceInfo, error) {
	database, err := dictionary.Open(ctx, dbPath, false)
	if errors.Is(err, os.ErrNotExist) {
		return []dictionary.SourceInfo{}, nil
	}
	if err != nil {
		return nil, err
	}
	defer database.Close()
	rows, err := database.QueryContext(ctx, `SELECT id, name, license, url, entry_count, imported_at FROM sources`)
	if err != nil {
		return nil, fmt.Errorf("list dictionary sources: %w", err)
	}
	defer rows.Close()
	byID := map[string]dictionary.SourceInfo{}
	var unknown []dictionary.SourceInfo
	for rows.Next() {
		var info dictionary.SourceInfo
		if err := rows.Scan(&info.ID, &info.Name, &info.License, &info.URL, &info.Entries, &info.ImportedAt); err != nil {
			return nil, fmt.Errorf("read dictionary source: %w", err)
		}
		if _, _, ok := dictionary.SourceByID(info.ID); ok {
			byID[info.ID] = info
		} else {
			unknown = append(unknown, info)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read dictionary sources: %w", err)
	}
	result := []dictionary.SourceInfo{}
	for _, spec := range dictionary.Sources {
		if info, ok := byID[spec.ID]; ok {
			result = append(result, info)
		}
	}
	return append(result, unknown...), nil
}

type parser func(ctx context.Context, input io.Reader, w *writer) error

func parserFor(sourceID string) (parser, error) {
	switch sourceID {
	case dictionary.SourceECDICT:
		return parseECDICT, nil
	case dictionary.SourceCEDICT:
		return parseCEDICT, nil
	case dictionary.SourceJMdict:
		return parseJMdict, nil
	case dictionary.SourceWiktionaryEN:
		return wiktextractParser(dictionary.English), nil
	case dictionary.SourceWiktionaryZH:
		return wiktextractParser(dictionary.Chinese), nil
	case dictionary.SourceWiktionaryJA:
		return wiktextractParser(dictionary.Japanese), nil
	}
	return nil, fmt.Errorf("unsupported dictionary source %q", sourceID)
}

func decompress(input io.Reader) (io.Reader, func(), error) {
	buffered := bufio.NewReaderSize(input, 1<<20)
	magic, err := buffered.Peek(2)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, nil, fmt.Errorf("read dictionary input: %w", err)
	}
	if len(magic) == 2 && magic[0] == 0x1f && magic[1] == 0x8b {
		gz, err := gzip.NewReader(buffered)
		if err != nil {
			return nil, nil, fmt.Errorf("open gzip input: %w", err)
		}
		return bufio.NewReaderSize(gz, 1<<20), func() { _ = gz.Close() }, nil
	}
	return buffered, func() {}, nil
}

type key struct {
	text string
	kind string
}

type record struct {
	from, to    dictionary.Lang
	headword    string
	reading     string
	pos         string
	definitions []string
	rank        int
	keys        []key
}

type writer struct {
	ctx        context.Context
	db         *sql.DB
	spec       dictionary.SourceSpec
	simplifier *dictionary.Simplifier
	options    Options

	tx        *sql.Tx
	insEntry  *sql.Stmt
	insKey    *sql.Stmt
	insT2S    *sql.Stmt
	started   bool
	committed bool
	inBatch   int
	total     int64
	t2sReset  bool
	// beforeFinish runs inside the last transaction, before the sources row is written.
	beforeFinish []func(*sql.Tx) error

	seenKeys map[string]struct{}
	warned   map[string]bool
}

// warnOnce reports message the first time id is seen.
func (w *writer) warnOnce(id, message string) {
	if w.warned == nil {
		w.warned = map[string]bool{}
	}
	if w.warned[id] {
		return
	}
	w.warned[id] = true
	if w.options.Warn != nil {
		w.options.Warn(message)
	}
}

func (w *writer) begin() error {
	if w.tx != nil {
		return nil
	}
	tx, err := w.db.BeginTx(w.ctx, nil)
	if err != nil {
		return fmt.Errorf("begin dictionary import: %w", err)
	}
	w.tx = tx
	if !w.started {
		w.started = true
		if err := deleteSource(w.ctx, tx, w.spec.ID); err != nil {
			return fmt.Errorf("remove previous %s rows: %w", w.spec.ID, err)
		}
	}
	if w.insEntry, err = tx.PrepareContext(w.ctx, `INSERT INTO entries
		(source_id, from_lang, to_lang, headword, reading, pos, definitions, rank)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`); err != nil {
		return fmt.Errorf("prepare entry insert: %w", err)
	}
	if w.insKey, err = tx.PrepareContext(w.ctx, `INSERT OR IGNORE INTO entry_keys
		(from_lang, to_lang, key, entry_id, kind) VALUES (?, ?, ?, ?, ?)`); err != nil {
		return fmt.Errorf("prepare key insert: %w", err)
	}
	return nil
}

func deleteSource(ctx context.Context, tx *sql.Tx, sourceID string) error {
	for _, statement := range []string{
		`DELETE FROM entry_keys WHERE entry_id IN (SELECT id FROM entries WHERE source_id = ?)`,
		`DELETE FROM entries WHERE source_id = ?`,
		`DELETE FROM sources WHERE id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, sourceID); err != nil {
			return err
		}
	}
	return nil
}

func (w *writer) closeStatements() {
	for _, statement := range []*sql.Stmt{w.insEntry, w.insKey, w.insT2S} {
		if statement != nil {
			_ = statement.Close()
		}
	}
	w.insEntry, w.insKey, w.insT2S = nil, nil, nil
}

func (w *writer) commit() error {
	if w.tx == nil {
		return nil
	}
	w.closeStatements()
	err := w.tx.Commit()
	w.tx = nil
	w.inBatch = 0
	if err != nil {
		return fmt.Errorf("commit dictionary batch: %w", err)
	}
	w.committed = true
	if w.options.Progress != nil {
		w.options.Progress(w.total)
	}
	return nil
}

// add stores one entry with its normalised, de-duplicated keys. Entries without usable keys are skipped.
func (w *writer) add(rec record) error {
	if err := w.ctx.Err(); err != nil {
		return err
	}
	if len(rec.definitions) == 0 || rec.headword == "" {
		return nil
	}
	clear(w.seenKeys)
	keys := make([]key, 0, len(rec.keys)+2)
	push := func(text, kind string) {
		if text == "" || utf8.RuneCountInString(text) > dictionary.MaxQueryRunes {
			return
		}
		if _, ok := w.seenKeys[text]; ok {
			return
		}
		w.seenKeys[text] = struct{}{}
		keys = append(keys, key{text, kind})
	}
	for _, k := range rec.keys {
		text := dictionary.NormalizeKey(rec.from, k.text)
		push(text, k.kind)
		if rec.from == dictionary.Japanese {
			// Katakana keys are also reachable through their hiragana spelling.
			push(dictionary.KatakanaToHiragana(text), k.kind)
		}
	}
	if len(keys) == 0 {
		return nil
	}
	definitions, err := json.Marshal(rec.definitions)
	if err != nil {
		return err
	}
	if err := w.begin(); err != nil {
		return err
	}
	result, err := w.insEntry.ExecContext(w.ctx, w.spec.ID, string(rec.from), string(rec.to),
		rec.headword, rec.reading, rec.pos, string(definitions), rec.rank)
	if err != nil {
		return fmt.Errorf("insert dictionary entry %q: %w", rec.headword, err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return err
	}
	for _, k := range keys {
		if _, err := w.insKey.ExecContext(w.ctx, string(rec.from), string(rec.to), k.text, id, k.kind); err != nil {
			return fmt.Errorf("insert dictionary key %q: %w", k.text, err)
		}
	}
	w.total++
	w.inBatch++
	if w.inBatch >= BatchSize {
		return w.commit()
	}
	return nil
}

// resetT2S clears zh_t2s once per import; the table is rebuilt by the CC-CEDICT import.
func (w *writer) resetT2S() error {
	if err := w.begin(); err != nil {
		return err
	}
	if w.t2sReset {
		return nil
	}
	w.t2sReset = true
	if _, err := w.tx.ExecContext(w.ctx, `DELETE FROM zh_t2s`); err != nil {
		return fmt.Errorf("clear Chinese variants: %w", err)
	}
	return nil
}

// addT2S records a Traditional→Simplified pair; the first pair of a word wins.
func (w *writer) addT2S(trad, simp string) error {
	if err := w.resetT2S(); err != nil {
		return err
	}
	if w.insT2S == nil {
		statement, err := w.tx.PrepareContext(w.ctx, `INSERT OR IGNORE INTO zh_t2s (trad, simp) VALUES (?, ?)`)
		if err != nil {
			return fmt.Errorf("prepare Chinese variant insert: %w", err)
		}
		w.insT2S = statement
	}
	if _, err := w.insT2S.ExecContext(w.ctx, trad, simp); err != nil {
		return fmt.Errorf("insert Chinese variant: %w", err)
	}
	return nil
}

func (w *writer) finish() error {
	if err := w.begin(); err != nil {
		return err
	}
	for _, step := range w.beforeFinish {
		if err := step(w.tx); err != nil {
			return err
		}
	}
	if _, err := w.tx.ExecContext(w.ctx, `INSERT INTO sources (id, name, license, url, entry_count, imported_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET name = excluded.name, license = excluded.license, url = excluded.url,
			entry_count = excluded.entry_count, imported_at = excluded.imported_at`,
		w.spec.ID, w.spec.Name, w.spec.License, w.spec.URL, w.total, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("record dictionary source: %w", err)
	}
	return w.commit()
}

// abort rolls back the open batch and removes rows already committed for the source.
func (w *writer) abort() error {
	if w.tx != nil {
		w.closeStatements()
		_ = w.tx.Rollback()
		w.tx = nil
	}
	if !w.committed {
		return nil
	}
	ctx := context.WithoutCancel(w.ctx)
	tx, err := w.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("clean up failed import: %w", err)
	}
	if err := deleteSource(ctx, tx, w.spec.ID); err != nil {
		return errors.Join(fmt.Errorf("clean up failed import: %w", err), tx.Rollback())
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("clean up failed import: %w", err)
	}
	return nil
}
