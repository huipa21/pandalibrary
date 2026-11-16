package dictionary

import (
	"errors"
	"strings"
	"testing"
)

const mwCollegiateFixture = `[{"meta":{"id":"voluminous","uuid":"0d01b967-971f-4ec5-8fe0-10513d29c39b","sort":"220130400","src":"collegiate","section":"alpha","stems":["voluminous","voluminously","voluminousness","voluminousnesses"],"offensive":false},
"hwi":{"hw":"vo*lu*mi*nous","prs":[{"mw":"v\u0259-\u02c8l\u00fc-m\u0259-n\u0259s","sound":{"audio":"volumi02","ref":"c","stat":"1"}}]},
"fl":"adjective",
"def":[{"sseq":[[["sense",{"sn":"1 a","dt":[["text","{bc}having or marked by great {a_link|volume} or bulk {bc}{sx|large||} "],["vis",[{"t":"long {wi}voluminous{\/wi} tresses"}]]],"sdsense":{"sd":"also","dt":[["text","{bc}{sx|full||} "],["vis",[{"t":"a {wi}voluminous{\/wi} skirt"}]]]}}],["sense",{"sn":"b","dt":[["text","{bc}{sx|numerous||} "],["vis",[{"t":"trying to keep track of {wi}voluminous{\/wi} slips of paper"}]]]}]],[["sense",{"sn":"2 a","dt":[["text","{bc}filling or capable of filling a large volume or several {a_link|volumes} "],["vis",[{"t":"a {wi}voluminous{\/wi} literature on the subject"}]]]}],["sense",{"sn":"b","dt":[["text","{bc}writing or speaking much or at great length "],["vis",[{"t":"a {wi}voluminous{\/wi} correspondent"}]]]}]],[["sense",{"sn":"3","dt":[["text","{bc}consisting of many folds, coils, or convolutions {bc}{sx|winding||}"]]}]]]}],
"uros":[{"ure":"vo*lu*mi*nous*ly","fl":"adverb"},{"ure":"vo*lu*mi*nous*ness","fl":"noun"}],
"et":[["text","Late Latin {it}voluminosus{\/it}, from Latin {it}volumin-, volumen{\/it}"]],
"date":"1611{ds||3||}",
"ld_link":{"link_hw":"voluminous","link_fl":"adjective"},
"suppl":{"examples":[{"t":"the building\u0027s high ceilings and {it}voluminous{\/it} spaces"},{"t":"a writer of {it}voluminous{\/it} output"}],"ldq":{"ldhw":"voluminous","fl":"adjective","def":[{"sls":["formal"],"sseq":[[["sense",{"dt":[["text","{bc}very large {bc}containing a lot of space"]]}]],[["sense",{"sls":["of clothing"],"dt":[["text","{bc}using large amounts of fabric {bc}very full"]]}]],[["sense",{"dt":[["text","{bc}having very many words or pages"]]}]]]}]}},
"shortdef":["having or marked by great volume or bulk : large; also : full","numerous","filling or capable of filling a large volume or several volumes"]},
{"meta":{"id":"volume:1","stems":["volume","volumes"]},"hwi":{"hw":"vol*ume"},"fl":"noun","shortdef":["a series of printed sheets bound together"]}]`

const mwThesaurusFixture = `[{"meta":{"id":"umpire","uuid":"1c8533d7-23e6-4c3b-9c48-854066e8caff","src":"coll_thes","section":"alpha","target":{"tuuid":"897edcad-2e88-4ab7-b81b-170ddf8eb4ec","tsrc":"collegiate"},"stems":["umpire","umpires"],"syns":[["adjudicator","arbiter","arbitrator","judge","referee"]],"ants":[],"offensive":false},
"hwi":{"hw":"umpire"},
"fl":"noun",
"def":[{"sseq":[[["sense",{"dt":[["text","a person who impartially decides or resolves a dispute or controversy "],["vis",[{"t":"usually acts as {it}umpire{/it} in the all-too-frequent squabbles between the two other roommates"}]]],"syn_list":[[{"wd":"adjudicator"},{"wd":"arbiter"},{"wd":"arbitrator"},{"wd":"judge"},{"wd":"referee"}]],"rel_list":[[{"wd":"jurist"},{"wd":"justice"},{"wd":"magistrate"}],[{"wd":"intermediary"},{"wd":"intermediate"},{"wd":"mediator"},{"wd":"mediatrix"},{"wd":"moderator"},{"wd":"negotiator"}],[{"wd":"conciliator"},{"wd":"go-between"},{"wd":"peacemaker"},{"wd":"reconciler"},{"wd":"troubleshooter"}],[{"wd":"decider"}]]}]]]}],
"shortdef":["a person who impartially decides or resolves a dispute or controversy"]}]`

func mwPreset(t *testing.T, kind string) Preset {
	t.Helper()
	preset, ok := PresetByKind(kind)
	if !ok {
		t.Fatalf("missing preset %s", kind)
	}
	return preset
}

func TestMWRequestURL(t *testing.T) {
	preset := mwPreset(t, KindMWCollegiate)
	cases := map[string]string{
		"ice cream": "https://www.dictionaryapi.com/api/v3/references/collegiate/json/ice%20cream?key=a%2Bb%26c",
		"naïve":     "https://www.dictionaryapi.com/api/v3/references/collegiate/json/na%C3%AFve?key=a%2Bb%26c",
		"a/b?":      "https://www.dictionaryapi.com/api/v3/references/collegiate/json/a%2Fb%3F?key=a%2Bb%26c",
	}
	for word, want := range cases {
		if got := mwRequestURL(preset, word, "a+b&c"); got != want {
			t.Errorf("mwRequestURL(%q) = %q, want %q", word, got, want)
		}
	}
}

func TestParseMWCollegiate(t *testing.T) {
	preset := mwPreset(t, KindMWCollegiate)
	entries, err := parseMW(preset, []byte(mwCollegiateFixture), "Voluminous")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v, want only voluminous", entries)
	}
	entry := entries[0]
	if entry.Headword != "voluminous" || entry.Reading != "və-ˈlü-mə-nəs" || entry.PartOfSpeech != "adjective" {
		t.Fatalf("entry = %+v", entry)
	}
	if entry.Match != MatchExact || entry.Source != KindMWCollegiate || entry.SourceName != preset.Name || entry.From != English || entry.To != English {
		t.Fatalf("entry metadata = %+v", entry)
	}
	if entry.AudioURL != "https://media.merriam-webster.com/audio/prons/en/us/mp3/v/volumi02.mp3" {
		t.Fatalf("audio = %q", entry.AudioURL)
	}
	want := []string{
		"having or marked by great volume or bulk : large; also : full",
		"numerous",
		"filling or capable of filling a large volume or several volumes",
		"Etymology: Late Latin voluminosus, from Latin volumin-, volumen",
		"Example: long voluminous tresses",
		"Example: a voluminous skirt",
	}
	if strings.Join(entry.Definitions, "\n") != strings.Join(want, "\n") {
		t.Fatalf("definitions = %q", entry.Definitions)
	}
	for _, line := range entry.Definitions {
		if strings.ContainsAny(line, "{}") {
			t.Fatalf("markup left in %q", line)
		}
	}
}

func TestParseMWStemIsLemma(t *testing.T) {
	entries, err := parseMW(mwPreset(t, KindMWCollegiate), []byte(mwCollegiateFixture), "voluminously")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Headword != "voluminous" || entries[0].Match != MatchLemma {
		t.Fatalf("entries = %+v", entries)
	}
	entries, err = parseMW(mwPreset(t, KindMWCollegiate), []byte(mwCollegiateFixture), "volume")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Headword != "volume" || entries[0].Match != MatchExact {
		t.Fatalf("entries = %+v", entries)
	}
}

func TestParseMWThesaurus(t *testing.T) {
	entries, err := parseMW(mwPreset(t, KindMWThesaurus), []byte(mwThesaurusFixture), "umpire")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("entries = %+v", entries)
	}
	entry := entries[0]
	if entry.Source != KindMWThesaurus || entry.Reading != "" || entry.AudioURL != "" || entry.PartOfSpeech != "noun" {
		t.Fatalf("entry = %+v", entry)
	}
	want := []string{
		"a person who impartially decides or resolves a dispute or controversy",
		"Synonyms: adjudicator, arbiter, arbitrator, judge, referee",
		"Related: jurist, justice, magistrate, intermediary, intermediate, mediator, mediatrix, moderator, negotiator, conciliator",
	}
	if strings.Join(entry.Definitions, "\n") != strings.Join(want, "\n") {
		t.Fatalf("definitions = %q", entry.Definitions)
	}
}

func TestParseMWNoEntries(t *testing.T) {
	preset := mwPreset(t, KindMWCollegiate)
	for _, body := range []string{`["volume","voluminal"]`, `[]`} {
		entries, err := parseMW(preset, []byte(body), "volumnous")
		if err != nil || entries != nil {
			t.Fatalf("parseMW(%s) = %+v, %v", body, entries, err)
		}
	}
}

func TestParseMWInvalidKey(t *testing.T) {
	_, err := parseMW(mwPreset(t, KindMWCollegiate), []byte("Invalid API key. Not subscribed for this reference."), "word")
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
	if len(err.Error()) > 200 {
		t.Fatalf("error too long: %q", err)
	}
}

func TestMWAudioURL(t *testing.T) {
	base := "https://media.merriam-webster.com/audio/prons/en/us/mp3/"
	cases := map[string]string{
		"bixgun01": base + "bix/bixgun01.mp3",
		"ggbye01":  base + "gg/ggbye01.mp3",
		"3d000001": base + "number/3d000001.mp3",
		"_ear01":   base + "number/_ear01.mp3",
		"Pluto01":  base + "p/Pluto01.mp3",
		"umpire01": base + "u/umpire01.mp3",
		"../x":     "",
		"a b":      "",
	}
	for audio, want := range cases {
		if got := mwAudioURL(audio); got != want {
			t.Errorf("mwAudioURL(%q) = %q, want %q", audio, got, want)
		}
	}
}

func TestCleanMW(t *testing.T) {
	got := cleanMW(`{bc}see {d_link|cat|cat:1} {ldquo}{it}x{/it}{rdquo} {et_link|lat|lat:2} {mat|dog|} {dx}compare {dxt|bird||}{/dx} 1611{ds||3||} {b}bold{/b}  {inf}2{/inf}`)
	want := "see cat \u201cx\u201d lat dog compare bird 1611 bold 2"
	if got != want {
		t.Fatalf("cleanMW = %q, want %q", got, want)
	}
}
