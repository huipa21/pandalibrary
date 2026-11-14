package dictionary

import (
	"slices"
	"testing"
)

func TestDeinflectEnglish(t *testing.T) {
	cases := map[string]string{
		"running": "run",
		"makes":   "make",
		"boxes":   "box",
		"cities":  "city",
		"stopped": "stop",
		"loved":   "love",
		"carried": "carry",
		"making":  "make",
		"lying":   "lie",
		"bigger":  "big",
		"happier": "happy",
		"largest": "large",
		"dog's":   "dog",
		"dogs'":   "dog",
	}
	for word, want := range cases {
		got := deinflectEnglish(word)
		if !slices.Contains(got, want) {
			t.Errorf("deinflectEnglish(%q) = %v, want it to contain %q", word, got, want)
		}
		if slices.Contains(got, word) {
			t.Errorf("deinflectEnglish(%q) contains the word itself", word)
		}
	}
	if got := deinflectEnglish("2024"); len(got) != 0 {
		t.Errorf("deinflectEnglish(2024) = %v, want none", got)
	}
}

func TestDeinflectJapanese(t *testing.T) {
	cases := map[string]string{
		"食べました":   "食べる",
		"食べません":   "食べる",
		"食べなかった":  "食べる",
		"食べたかった":  "食べる",
		"食べられる":   "食べる",
		"食べさせられた": "食べる",
		"食べよう":    "食べる",
		"食べています":  "食べる",
		"書いて":     "書く",
		"泳いだ":     "泳ぐ",
		"話します":    "話す",
		"待った":     "待つ",
		"死んだ":     "死ぬ",
		"読まない":    "読む",
		"読めば":     "読む",
		"読める":     "読む",
		"買いたい":    "買う",
		"行って":     "行く",
		"勉強しました":  "勉強する",
		"来ます":     "来る",
		"こない":     "くる",
		"高かった":    "高い",
		"高くない":    "高い",
		"高くなかった":  "高い",
		"高くて":     "高い",
		"高さ":      "高い",
	}
	for text, want := range cases {
		got := deinflectJapanese(text)
		if !slices.Contains(got, want) {
			t.Errorf("deinflectJapanese(%q) = %v, want it to contain %q", text, got, want)
		}
		if slices.Contains(got, text) {
			t.Errorf("deinflectJapanese(%q) contains the text itself", text)
		}
	}
	if got := deinflectJapanese("勉強しました"); !slices.Contains(got, "勉強") {
		t.Errorf("deinflectJapanese(勉強しました) = %v, want it to contain the noun 勉強", got)
	}
	// Rules restricted to the original text do not chain: ます must not be stripped twice.
	if got := deinflectJapanese("食べ"); slices.Contains(got, "食べるる") {
		t.Errorf("deinflectJapanese(食べ) chained a stem rule: %v", got)
	}
}
