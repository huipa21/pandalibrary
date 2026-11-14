package dictimport

import (
	"bytes"
	"compress/gzip"
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"pandalibrary/internal/dictionary"
)

func importString(t *testing.T, dbPath, sourceID, input string) (int64, []string) {
	t.Helper()
	var warnings []string
	count, err := Import(context.Background(), dbPath, sourceID, strings.NewReader(input), Options{
		Warn: func(message string) { warnings = append(warnings, message) },
	})
	if err != nil {
		t.Fatalf("Import(%s): %v", sourceID, err)
	}
	return count, warnings
}

func openDB(t *testing.T, dbPath string) *sql.DB {
	t.Helper()
	database, err := dictionary.Open(context.Background(), dbPath, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return database
}

type storedEntry struct {
	source, from, to, headword, reading, pos string
	definitions                              []string
	rank                                     int
}

// lookupKey returns the entries reachable through an exact stored key, with each matching key kind.
func lookupKey(t *testing.T, database *sql.DB, from, to, keyText string) ([]storedEntry, []string) {
	t.Helper()
	rows, err := database.Query(`SELECT e.source_id, e.from_lang, e.to_lang, e.headword, e.reading, e.pos, e.definitions, e.rank, k.kind
		FROM entry_keys k JOIN entries e ON e.id = k.entry_id
		WHERE k.from_lang = ? AND k.to_lang = ? AND k.key = ? ORDER BY e.rank, e.id`, from, to, keyText)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var entries []storedEntry
	var kinds []string
	for rows.Next() {
		var entry storedEntry
		var definitions, kind string
		if err := rows.Scan(&entry.source, &entry.from, &entry.to, &entry.headword, &entry.reading, &entry.pos, &definitions, &entry.rank, &kind); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(definitions), &entry.definitions); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, entry)
		kinds = append(kinds, kind)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return entries, kinds
}

func countRows(t *testing.T, database *sql.DB, query string, args ...any) int {
	t.Helper()
	var count int
	if err := database.QueryRow(query, args...).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

const ecdictFixture = "\ufeffword,phonetic,definition,translation,pos,collins,oxford,tag,bnc,frq,exchange,detail,audio\n" +
	`perceive,pә'si:v,v. to become aware of,"vt. 察觉, 感知\nvt. 理解",,3,1,cet4,3000,2500,p:perceived/d:perceived/3:perceives/i:perceiving,,` + "\n" +
	`Rare,reә,,"a. 稀有的",,,,,0,0,r:rarer/t:rarest/0:rare/1:p,,` + "\n" +
	`blank,,,,,,,,,,,,` + "\n"

func TestImportECDICT(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	count, _ := importString(t, dbPath, dictionary.SourceECDICT, ecdictFixture)
	if count != 2 {
		t.Fatalf("count = %d, want 2 (empty translation skipped)", count)
	}
	database := openDB(t, dbPath)
	entries, kinds := lookupKey(t, database, "en", "zh", "perceive")
	if len(entries) != 1 || kinds[0] != dictionary.KeyHeadword {
		t.Fatalf("perceive = %+v %v", entries, kinds)
	}
	if want := []string{"vt. 察觉, 感知", "vt. 理解"}; !slices.Equal(entries[0].definitions, want) {
		t.Fatalf("definitions = %q, want %q", entries[0].definitions, want)
	}
	if entries[0].rank != 2500 || entries[0].reading != "pә'si:v" {
		t.Fatalf("entry = %+v", entries[0])
	}
	for _, form := range []string{"perceived", "perceives", "perceiving"} {
		if _, kinds := lookupKey(t, database, "en", "zh", form); !slices.Equal(kinds, []string{dictionary.KeyForm}) {
			t.Fatalf("form %s kinds = %v", form, kinds)
		}
	}
	rare, _ := lookupKey(t, database, "en", "zh", "rare")
	if len(rare) != 1 || rare[0].headword != "Rare" || rare[0].rank != ecdictUnranked {
		t.Fatalf("rare = %+v", rare)
	}
	if _, kinds := lookupKey(t, database, "en", "zh", "rarest"); len(kinds) != 1 {
		t.Fatalf("rarest kinds = %v", kinds)
	}
	if _, kinds := lookupKey(t, database, "en", "zh", "p"); len(kinds) != 0 {
		t.Fatalf("exchange type 1 must not be indexed: %v", kinds)
	}
}

const cedictFixture = "# CC-CEDICT\n" +
	"#! version=1\n" +
	"字典 字典 [zi4 dian3] /dictionary/CL:本[ben3]/\n" +
	"詞典 词典 [ci2 dian3] /dictionary/\n" +
	"乾 干 [gan1] /dry/\n" +
	"乾 乾 [qian2] /surname Qian/\n" +
	"乾燥 干燥 [gan1 zao4] /dry/arid/\n" +
	"語 语 [yu3] /language/\n" +
	"broken line\n"

func TestImportCEDICT(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	count, _ := importString(t, dbPath, dictionary.SourceCEDICT, cedictFixture)
	if count != 6 {
		t.Fatalf("count = %d, want 6", count)
	}
	database := openDB(t, dbPath)
	entries, kinds := lookupKey(t, database, "zh", "en", "词典")
	if len(entries) != 1 || entries[0].headword != "词典" || entries[0].reading != "ci2 dian3" || kinds[0] != dictionary.KeyHeadword {
		t.Fatalf("词典 = %+v %v", entries, kinds)
	}
	if _, kinds := lookupKey(t, database, "zh", "en", "詞典"); !slices.Equal(kinds, []string{dictionary.KeyVariant}) {
		t.Fatalf("詞典 kinds = %v", kinds)
	}
	if entries, _ := lookupKey(t, database, "zh", "en", "字典"); len(entries) != 1 || !slices.Equal(entries[0].definitions, []string{"dictionary", "CL:本[ben3]"}) {
		t.Fatalf("字典 = %+v", entries)
	}
	simplifier, err := dictionary.LoadSimplifier(context.Background(), database)
	if err != nil {
		t.Fatal(err)
	}
	// 乾 is also a Simplified character, so it only converts inside known words.
	if got := simplifier.Simplify("詞典語乾燥乾"); got != "词典语干燥乾" {
		t.Fatalf("Simplify = %q", got)
	}
	if n := countRows(t, database, `SELECT count(*) FROM zh_t2s`); n != 3 {
		t.Fatalf("zh_t2s rows = %d, want 3", n)
	}
}

const jmdictFixture = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE JMdict [
<!ELEMENT JMdict (entry*)>
<!ENTITY v1 "Ichidan verb">
<!ENTITY vt "transitive verb">
<!ENTITY n "noun (common) (futsuumeishi)">
]>
<JMdict>
<entry>
<ent_seq>1358280</ent_seq>
<k_ele><keb>食べる</keb><ke_pri>ichi1</ke_pri><ke_pri>nf05</ke_pri></k_ele>
<k_ele><keb>喰べる</keb></k_ele>
<r_ele><reb>たべる</reb><re_pri>ichi1</re_pri></r_ele>
<sense><pos>&v1;</pos><pos>&vt;</pos><gloss>to eat</gloss><gloss>to live on (e.g. a salary)</gloss></sense>
<sense><gloss g_type="expl">a very long explanatory gloss that should not be reversed</gloss><gloss xml:lang="ger">essen</gloss></sense>
</entry>
<entry>
<ent_seq>1</ent_seq>
<r_ele><reb>コーヒー</reb></r_ele>
<sense><pos>&n;</pos><gloss>coffee</gloss></sense>
</entry>
</JMdict>
`

func TestImportJMdict(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	count, _ := importString(t, dbPath, dictionary.SourceJMdict, jmdictFixture)
	// 2 ja→en entries + "eat", "live on", "coffee" reverse entries.
	if count != 5 {
		t.Fatalf("count = %d, want 5", count)
	}
	database := openDB(t, dbPath)
	entries, kinds := lookupKey(t, database, "ja", "en", "たべる")
	if len(entries) != 1 || kinds[0] != dictionary.KeyReading {
		t.Fatalf("たべる = %+v %v", entries, kinds)
	}
	eat := entries[0]
	if eat.headword != "食べる" || eat.reading != "たべる" || eat.pos != "v1, vt" || eat.rank != 5 {
		t.Fatalf("食べる = %+v", eat)
	}
	if want := []string{"to eat; to live on (e.g. a salary)", "a very long explanatory gloss that should not be reversed"}; !slices.Equal(eat.definitions, want) {
		t.Fatalf("definitions = %q", eat.definitions)
	}
	if _, kinds := lookupKey(t, database, "ja", "en", "喰べる"); !slices.Equal(kinds, []string{dictionary.KeyHeadword}) {
		t.Fatalf("喰べる kinds = %v", kinds)
	}
	coffee, _ := lookupKey(t, database, "ja", "en", "こーひー")
	if len(coffee) != 1 || coffee[0].headword != "コーヒー" || coffee[0].reading != "" || coffee[0].pos != "n" || coffee[0].rank != jmdictUnranked {
		t.Fatalf("hiragana key for コーヒー = %+v", coffee)
	}
	reverse, _ := lookupKey(t, database, "en", "ja", "eat")
	if len(reverse) != 1 || reverse[0].headword != "eat" || !slices.Equal(reverse[0].definitions, []string{"食べる（たべる）"}) {
		t.Fatalf("eat = %+v", reverse)
	}
	if reverse, _ := lookupKey(t, database, "en", "ja", "live on"); len(reverse) != 1 {
		t.Fatalf("live on = %+v", reverse)
	}
	if reverse, _ := lookupKey(t, database, "en", "ja", "coffee"); len(reverse) != 1 || reverse[0].definitions[0] != "コーヒー" {
		t.Fatalf("coffee = %+v", reverse)
	}
	if n := countRows(t, database, `SELECT count(*) FROM entries WHERE from_lang = 'en' AND headword LIKE '%explanatory%'`); n != 0 {
		t.Fatalf("explanatory gloss reversed")
	}
}

const wiktextractFixture = `{"word": "dictionary", "lang_code": "en", "pos": "noun", "forms": [{"form": "dictionaries", "tags": ["plural"]}], "senses": [{"glosses": ["A reference work listing words."]}]}
{"word": "Wörterbuch", "lang_code": "de", "pos": "noun", "senses": [{"glosses": ["dictionary"]}]}
{"title": "Dict", "redirect": "dictionary"}
{"word": "詞典", "lang_code": "zh", "pos": "noun", "sounds": [{"zh-pron": "cídiǎn", "tags": ["Mandarin", "Pinyin"]}], "senses": [{"glosses": ["dictionary"]}]}
{"word": "辞書", "lang_code": "ja", "pos": "noun", "forms": [{"form": "じしょ", "tags": ["hiragana"]}, {"form": "jisho", "tags": ["romanization"]}], "senses": [{"glosses": ["dictionary"]}, {"glosses": ["dictionary"]}]}
{"word": "dictionaries", "lang_code": "en", "pos": "noun", "senses": [{"glosses": ["plural of dictionary"], "tags": ["form-of", "plural"]}]}
{"word": "字典", "lang_code": "cmn", "pos": "noun", "senses": []}
`

func TestImportWiktextractEnglishEdition(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "dict.db")
	importString(t, dbPath, dictionary.SourceCEDICT, cedictFixture)
	count, warnings := importString(t, dbPath, dictionary.SourceWiktionaryEN, wiktextractFixture)
	if count != 4 || len(warnings) != 0 {
		t.Fatalf("count = %d warnings = %v", count, warnings)
	}
	database := openDB(t, dbPath)
	if entries, kinds := lookupKey(t, database, "en", "en", "dictionaries"); len(entries) != 2 || !slices.Contains(kinds, dictionary.KeyForm) || !slices.Contains(kinds, dictionary.KeyHeadword) {
		t.Fatalf("dictionaries = %+v %v", entries, kinds)
	} else if entries[0].headword != "dictionary" || entries[1].rank != 1 {
		t.Fatalf("form-of entry should rank after the lemma: %+v", entries)
	}
	zh, kinds := lookupKey(t, database, "zh", "en", "词典")
	zh = slices.DeleteFunc(zh, func(entry storedEntry) bool { return entry.source != dictionary.SourceWiktionaryEN })
	if len(zh) != 1 || zh[0].headword != "词典" || zh[0].reading != "cídiǎn" || kinds[0] != dictionary.KeyHeadword {
		t.Fatalf("词典 = %+v %v", zh, kinds)
	}
	ja, _ := lookupKey(t, database, "ja", "en", "じしょ")
	if len(ja) != 1 || ja[0].headword != "辞書" || ja[0].reading != "じしょ" || !slices.Equal(ja[0].definitions, []string{"dictionary"}) {
		t.Fatalf("じしょ = %+v", ja)
	}
	if _, kinds := lookupKey(t, database, "ja", "en", "jisho"); len(kinds) != 0 {
		t.Fatalf("romanization indexed")
	}
	if n := countRows(t, database, `SELECT count(*) FROM entries WHERE source_id = ? AND headword = 'Wörterbuch'`, dictionary.SourceWiktionaryEN); n != 0 {
		t.Fatalf("German entry imported")
	}
}

func TestImportWiktextractChineseEditionSimplifiesAndWarns(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	input := `{"word": "dictionary", "lang_code": "en", "pos": "noun", "senses": [{"glosses": ["詞典"]}]}` + "\n" +
		`{"word": "詞典", "lang_code": "zh", "pos": "noun", "senses": [{"glosses": ["語言詞典"]}]}`
	_, warnings := importString(t, dbPath, dictionary.SourceWiktionaryZH, input)
	if len(warnings) != 1 || !strings.Contains(warnings[0], "zh_t2s") {
		t.Fatalf("warnings = %v", warnings)
	}
	importString(t, dbPath, dictionary.SourceCEDICT, cedictFixture)
	_, warnings = importString(t, dbPath, dictionary.SourceWiktionaryZH, input)
	if len(warnings) != 0 {
		t.Fatalf("warnings = %v", warnings)
	}
	database := openDB(t, dbPath)
	en, _ := lookupKey(t, database, "en", "zh", "dictionary")
	if len(en) != 1 || !slices.Equal(en[0].definitions, []string{"词典"}) {
		t.Fatalf("dictionary = %+v", en)
	}
	zh, _ := lookupKey(t, database, "zh", "zh", "词典")
	if len(zh) != 1 || zh[0].headword != "词典" || !slices.Equal(zh[0].definitions, []string{"语言词典"}) {
		t.Fatalf("词典 = %+v", zh)
	}
	if _, kinds := lookupKey(t, database, "zh", "zh", "詞典"); !slices.Equal(kinds, []string{dictionary.KeyVariant}) {
		t.Fatalf("詞典 kinds = %v", kinds)
	}
}

func TestReimportReplacesSourceRows(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	importString(t, dbPath, dictionary.SourceCEDICT, cedictFixture)
	importString(t, dbPath, dictionary.SourceECDICT, ecdictFixture)
	count, _ := importString(t, dbPath, dictionary.SourceCEDICT, "語 语 [yu3] /language/\n")
	if count != 1 {
		t.Fatalf("count = %d", count)
	}
	database := openDB(t, dbPath)
	if n := countRows(t, database, `SELECT count(*) FROM entries WHERE source_id = ?`, dictionary.SourceCEDICT); n != 1 {
		t.Fatalf("cc-cedict entries = %d, want 1", n)
	}
	if n := countRows(t, database, `SELECT count(*) FROM entry_keys WHERE from_lang = 'zh'`); n != 2 {
		t.Fatalf("zh keys = %d, want 2", n)
	}
	if n := countRows(t, database, `SELECT count(*) FROM entries WHERE source_id = ?`, dictionary.SourceECDICT); n != 2 {
		t.Fatalf("ecdict entries = %d, want 2 (untouched)", n)
	}
	if n := countRows(t, database, `SELECT count(*) FROM zh_t2s`); n != 1 {
		t.Fatalf("zh_t2s rows = %d, want 1", n)
	}
	sources, err := List(context.Background(), dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(sources) != 2 || sources[0].ID != dictionary.SourceECDICT || sources[1].ID != dictionary.SourceCEDICT ||
		sources[1].Entries != 1 || sources[1].Name != "CC-CEDICT" || sources[1].ImportedAt == 0 {
		t.Fatalf("sources = %+v", sources)
	}
}

func TestFailedImportKeepsPreviousRows(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dict.db")
	importString(t, dbPath, dictionary.SourceWiktionaryEN, wiktextractFixture)
	_, err := Import(context.Background(), dbPath, dictionary.SourceWiktionaryEN,
		strings.NewReader(`{"word": "x", "lang_code": "en", "senses": [{"glosses": ["y"]}]}`+"\n"+`{"lang_code": "en", broken`), Options{})
	if err == nil {
		t.Fatal("expected parse error")
	}
	database := openDB(t, dbPath)
	if n := countRows(t, database, `SELECT count(*) FROM entries WHERE source_id = ?`, dictionary.SourceWiktionaryEN); n != 4 {
		t.Fatalf("entries = %d, want previous 4", n)
	}
}

func TestImportGzipAndList(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "dictionaries", "dict.db")
	if sources, err := List(context.Background(), dbPath); err != nil || len(sources) != 0 || sources == nil {
		t.Fatalf("List on missing db = %v, %v", sources, err)
	}
	var compressed bytes.Buffer
	gz := gzip.NewWriter(&compressed)
	if _, err := gz.Write([]byte(cedictFixture)); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	var progress []int64
	count, err := Import(context.Background(), dbPath, dictionary.SourceCEDICT, &compressed, Options{
		Progress: func(entries int64) { progress = append(progress, entries) },
	})
	if err != nil || count != 6 {
		t.Fatalf("Import = %d, %v", count, err)
	}
	if len(progress) == 0 || progress[len(progress)-1] != 6 {
		t.Fatalf("progress = %v", progress)
	}
	if _, err := Import(context.Background(), dbPath, "unknown", strings.NewReader(""), Options{}); err == nil {
		t.Fatal("unknown source accepted")
	}
}
