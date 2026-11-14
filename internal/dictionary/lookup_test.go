package dictionary

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type testKey struct{ key, kind string }

type testEntry struct {
	source, from, to, headword, reading string
	definitions                         []string
	rank                                int
	keys                                []testKey
}

func createTestDictionary(t *testing.T, path string) {
	t.Helper()
	ctx := context.Background()
	database, err := Open(ctx, path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	entries := []testEntry{
		{SourceWiktionaryZH, "en", "zh", "test", "", []string{"测验"}, 1, []testKey{{"test", KeyHeadword}}},
		{SourceECDICT, "en", "zh", "test", "", []string{"测试"}, 50, []testKey{{"test", KeyHeadword}}},
		{SourceECDICT, "en", "zh", "test", "", []string{"试验"}, 5, []testKey{{"test", KeyHeadword}}},
		{SourceECDICT, "en", "zh", "run", "", []string{"跑", "运行"}, 10, []testKey{{"run", KeyHeadword}, {"ran", KeyForm}}},
		{SourceECDICT, "en", "zh", "look", "", []string{"看"}, 10, []testKey{{"look", KeyHeadword}}},
		{SourceCEDICT, "zh", "en", "学习", "xue2 xi2", []string{"to learn", "to study"}, 0, []testKey{{"学习", KeyHeadword}, {"學習", KeyVariant}}},
		{SourceCEDICT, "zh", "en", "学", "xue2", []string{"to learn"}, 0, []testKey{{"学", KeyHeadword}, {"學", KeyVariant}}},
		{SourceJMdict, "ja", "en", "食べる", "たべる", []string{"to eat"}, 0, []testKey{{"食べる", KeyHeadword}, {"たべる", KeyReading}}},
		{SourceJMdict, "ja", "en", "日本", "にほん", []string{"Japan"}, 0, []testKey{{"日本", KeyHeadword}, {"にほん", KeyReading}}},
		{SourceJMdict, "ja", "en", "日本語", "にほんご", []string{"Japanese (language)"}, 0, []testKey{{"日本語", KeyHeadword}, {"にほんご", KeyReading}}},
	}
	for index, entry := range entries {
		definitions, err := json.Marshal(entry.definitions)
		if err != nil {
			t.Fatal(err)
		}
		id := index + 1
		if _, err := database.ExecContext(ctx,
			`INSERT INTO entries (id, source_id, from_lang, to_lang, headword, reading, pos, definitions, rank)
			VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)`,
			id, entry.source, entry.from, entry.to, entry.headword, entry.reading, string(definitions), entry.rank); err != nil {
			t.Fatal(err)
		}
		for _, key := range entry.keys {
			if _, err := database.ExecContext(ctx,
				`INSERT INTO entry_keys (from_lang, to_lang, key, entry_id, kind) VALUES (?, ?, ?, ?, ?)`,
				entry.from, entry.to, NormalizeKey(Lang(entry.from), key.key), id, key.kind); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, source := range []string{SourceECDICT, SourceCEDICT, SourceJMdict, SourceWiktionaryZH} {
		spec, _, _ := SourceByID(source)
		if _, err := database.ExecContext(ctx,
			`INSERT INTO sources (id, name, license, url, entry_count, imported_at) VALUES (?, ?, ?, ?, 1, 1700000000000)`,
			spec.ID, spec.Name, spec.License, spec.URL); err != nil {
			t.Fatal(err)
		}
	}
	for trad, simp := range map[string]string{"學": "学", "習": "习"} {
		if _, err := database.ExecContext(ctx, `INSERT INTO zh_t2s (trad, simp) VALUES (?, ?)`, trad, simp); err != nil {
			t.Fatal(err)
		}
	}
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "dictionaries.db")
	createTestDictionary(t, path)
	store := NewStore(path, nil)
	t.Cleanup(func() { _ = store.Close() })
	return store
}

type summary struct {
	Source, Headword string
	Match            MatchKind
}

func summarize(entries []Entry) []summary {
	out := []summary{}
	for _, entry := range entries {
		out = append(out, summary{entry.Source, entry.Headword, entry.Match})
	}
	return out
}

func TestLookup(t *testing.T) {
	store := newTestStore(t)
	cases := []struct {
		name     string
		query    Query
		wantTerm string
		want     []summary
	}{
		{"english exact ordered by source then rank", Query{Text: " Test ", From: English, To: Chinese},
			"test", []summary{{SourceECDICT, "test", MatchExact}, {SourceECDICT, "test", MatchExact}, {SourceWiktionaryZH, "test", MatchExact}}},
		{"english deinflection", Query{Text: "Running", From: English, To: Chinese},
			"run", []summary{{SourceECDICT, "run", MatchLemma}}},
		{"english stored form", Query{Text: "ran", From: English, To: Chinese},
			"ran", []summary{{SourceECDICT, "run", MatchLemma}}},
		{"english first words", Query{Text: "looking up", From: English, To: Chinese},
			"look", []summary{{SourceECDICT, "look", MatchPrefix}}},
		{"traditional chinese", Query{Text: "學習", From: Chinese, To: English},
			"学习", []summary{{SourceCEDICT, "学习", MatchExact}}},
		{"chinese prefix", Query{Text: "学习中文", From: Chinese, To: English},
			"学习", []summary{{SourceCEDICT, "学习", MatchPrefix}}},
		{"japanese kanji", Query{Text: "食べる", From: Japanese, To: English},
			"食べる", []summary{{SourceJMdict, "食べる", MatchExact}}},
		{"japanese katakana reading", Query{Text: "タベル", From: Japanese, To: English},
			"たべる", []summary{{SourceJMdict, "食べる", MatchExact}}},
		{"japanese inflection", Query{Text: "食べました", From: Japanese, To: English},
			"食べる", []summary{{SourceJMdict, "食べる", MatchLemma}}},
		{"japanese longest prefix", Query{Text: "日本語を勉強", From: Japanese, To: English},
			"日本語", []summary{{SourceJMdict, "日本語", MatchPrefix}}},
		{"japanese inflected prefix", Query{Text: "食べましたか", From: Japanese, To: English},
			"食べる", []summary{{SourceJMdict, "食べる", MatchPrefix}}},
		{"no match", Query{Text: "zzz", From: English, To: Chinese}, "zzz", []summary{}},
		{"other direction", Query{Text: "test", From: English, To: Japanese}, "test", []summary{}},
		{"limit", Query{Text: "test", From: English, To: Chinese, Limit: 1},
			"test", []summary{{SourceECDICT, "test", MatchExact}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := store.Lookup(context.Background(), tc.query)
			if err != nil {
				t.Fatal(err)
			}
			if result.Entries == nil {
				t.Fatal("entries must not be nil")
			}
			if result.Term != tc.wantTerm {
				t.Errorf("term = %q, want %q", result.Term, tc.wantTerm)
			}
			if got := summarize(result.Entries); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("entries = %+v, want %+v", got, tc.want)
			}
		})
	}

	result, err := store.Lookup(context.Background(), Query{Text: "test", From: English, To: Chinese})
	if err != nil {
		t.Fatal(err)
	}
	first := result.Entries[0]
	if first.SourceName != "ECDICT" || !reflect.DeepEqual(first.Definitions, []string{"试验"}) {
		t.Errorf("first entry = %+v, want ECDICT rank 5 entry", first)
	}
}

func TestLookupInvalid(t *testing.T) {
	store := newTestStore(t)
	for name, query := range map[string]Query{
		"empty":      {Text: "  ", From: English, To: Chinese},
		"too long":   {Text: strings.Repeat("字", MaxQueryRunes+1), From: Chinese, To: English},
		"bad from":   {Text: "test", From: "fr", To: Chinese},
		"bad to":     {Text: "test", From: English, To: ""},
		"limit low":  {Text: "test", From: English, To: Chinese, Limit: -1},
		"limit high": {Text: "test", From: English, To: Chinese, Limit: MaxLimit + 1},
	} {
		if _, err := store.Lookup(context.Background(), query); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

func TestStoreMissingDatabase(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "dictionaries", "dictionaries.db")
	store := NewStore(path, nil)
	defer store.Close()

	result, err := store.Lookup(ctx, Query{Text: "test", From: English, To: Chinese})
	if err != nil {
		t.Fatal(err)
	}
	if result.Entries == nil || len(result.Entries) != 0 {
		t.Errorf("entries = %#v, want empty", result.Entries)
	}
	status, err := store.Status(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if status.Directions == nil || status.Sources == nil || len(status.Directions)+len(status.Sources) != 0 {
		t.Errorf("status = %#v, want empty lists", status)
	}

	// An import while the server runs becomes visible without restarting.
	createTestDictionary(t, path)
	result, err = store.Lookup(ctx, Query{Text: "test", From: English, To: Chinese})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 3 {
		t.Errorf("entries after import = %d, want 3", len(result.Entries))
	}
}

func TestStoreReloadsSimplifierAfterImport(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	if _, err := store.Lookup(ctx, Query{Text: "學", From: Chinese, To: English}); err != nil {
		t.Fatal(err)
	}
	writer, err := Open(ctx, store.path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	mustExec(t, writer, `INSERT INTO zh_t2s (trad, simp) VALUES ('體', '体')`)
	mustExec(t, writer, `INSERT INTO entries (id, source_id, from_lang, to_lang, headword, definitions) VALUES (100, 'cc-cedict', 'zh', 'en', '体', '["body"]')`)
	mustExec(t, writer, `INSERT INTO entry_keys (from_lang, to_lang, key, entry_id, kind) VALUES ('zh', 'en', '体', 100, 'headword')`)
	mustExec(t, writer, `UPDATE sources SET imported_at = imported_at + 1 WHERE id = 'cc-cedict'`)

	result, err := store.Lookup(ctx, Query{Text: "體", From: Chinese, To: English})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("simplifier reloaded before the refresh interval: %+v", result.Entries)
	}
	store.mu.Lock()
	store.checkedAt = store.checkedAt.Add(-refreshInterval)
	store.mu.Unlock()
	result, err = store.Lookup(ctx, Query{Text: "體", From: Chinese, To: English})
	if err != nil {
		t.Fatal(err)
	}
	if result.Term != "体" || len(result.Entries) != 1 {
		t.Errorf("result = %+v, want 体 after refresh", result)
	}
}

func mustExec(t *testing.T, database *sql.DB, query string) {
	t.Helper()
	if _, err := database.ExecContext(context.Background(), query); err != nil {
		t.Fatal(err)
	}
}

func TestStatus(t *testing.T) {
	store := newTestStore(t)
	status, err := store.Status(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantDirections := []Direction{
		{From: English, To: Chinese, Sources: []string{SourceECDICT, SourceWiktionaryZH}},
		{From: Chinese, To: English, Sources: []string{SourceCEDICT}},
		{From: Japanese, To: English, Sources: []string{SourceJMdict}},
	}
	if !reflect.DeepEqual(status.Directions, wantDirections) {
		t.Errorf("directions = %+v, want %+v", status.Directions, wantDirections)
	}
	var ids []string
	for _, source := range status.Sources {
		ids = append(ids, source.ID)
	}
	if want := []string{SourceECDICT, SourceCEDICT, SourceJMdict, SourceWiktionaryZH}; !reflect.DeepEqual(ids, want) {
		t.Errorf("sources = %v, want %v", ids, want)
	}
	if status.Sources[0].Name != "ECDICT" || status.Sources[0].ImportedAt != 1700000000000 || status.Sources[0].Entries != 1 {
		t.Errorf("source = %+v", status.Sources[0])
	}
}
