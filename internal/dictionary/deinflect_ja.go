package dictionary

import (
	"strings"
	"sync"
)

// Word classes used by the Japanese deinflector. A rule applies to a candidate when
// the candidate is the original text or its class intersects the rule's input classes.
const (
	jaV1    uint16 = 1 << iota // ichidan verb (dictionary form ends in る)
	jaV5                       // godan verb
	jaVS                       // する verb
	jaVK                       // 来る
	jaAdjI                     // i-adjective, also ない/たい forms
	jaTe                       // て/で form
	jaNoun                     // stem with no further inflection (e.g. noun before する/です)
	jaFinal uint16 = 0         // the rule only applies to the original text
)

type jaRule struct {
	in, out string
	from    uint16 // classes the inflected form may have
	to      uint16 // class of the result
}

type godanRow struct {
	u, i, a, e, o, te, ta string
}

var godanRows = []godanRow{
	{"う", "い", "わ", "え", "お", "って", "った"},
	{"く", "き", "か", "け", "こ", "いて", "いた"},
	{"ぐ", "ぎ", "が", "げ", "ご", "いで", "いだ"},
	{"す", "し", "さ", "せ", "そ", "して", "した"},
	{"つ", "ち", "た", "て", "と", "って", "った"},
	{"ぬ", "に", "な", "ね", "の", "んで", "んだ"},
	{"ぶ", "び", "ば", "べ", "ぼ", "んで", "んだ"},
	{"む", "み", "ま", "め", "も", "んで", "んだ"},
	{"る", "り", "ら", "れ", "ろ", "って", "った"},
}

// politeEndings follow the masu stem and end the word.
var politeEndings = []string{"ます", "ました", "ません", "ませんでした", "ましょう", "まして", "ませ"}

var japaneseRules = sync.OnceValue(buildJapaneseRules)

func buildJapaneseRules() []jaRule {
	var rules []jaRule
	add := func(in, out string, from, to uint16) {
		rules = append(rules, jaRule{in: in, out: out, from: from, to: to})
	}
	// verb builds rules for a verb class whose forms are stem+suffix.
	verb := func(dict string, to uint16, masuStem, negStem, te, ta, potential, passive, causative, volitional, conditional, imperative string) {
		for _, ending := range politeEndings {
			add(masuStem+ending, dict, jaFinal, to)
		}
		add(masuStem+"たい", dict, jaAdjI, to)
		add(masuStem+"ながら", dict, jaFinal, to)
		add(masuStem+"なさい", dict, jaFinal, to)
		add(masuStem+"そう", dict, jaFinal, to)
		add(te, dict, jaTe, to)
		add(ta, dict, jaFinal, to)
		add(ta+"ら", dict, jaFinal, to)
		add(ta+"り", dict, jaFinal, to)
		add(negStem+"ない", dict, jaAdjI, to)
		add(negStem+"ず", dict, jaFinal, to)
		add(negStem+"ずに", dict, jaFinal, to)
		add(negStem+"ぬ", dict, jaFinal, to)
		if potential != "" {
			add(potential, dict, jaV1, to)
		}
		add(passive, dict, jaV1, to)
		add(causative, dict, jaV1, to)
		add(volitional, dict, jaFinal, to)
		add(conditional, dict, jaFinal, to)
		if imperative != "" {
			add(imperative, dict, jaFinal, to)
		}
	}

	for _, row := range godanRows {
		verb(row.u, jaV5, row.i, row.a, row.te, row.ta, row.e+"る", row.a+"れる", row.a+"せる",
			row.o+"う", row.e+"ば", row.e)
		add(row.i, row.u, jaFinal, jaV5) // masu stem / continuative form
	}
	// 行く is irregular in its て/た forms.
	add("行って", "行く", jaTe, jaV5)
	add("行った", "行く", jaFinal, jaV5)
	add("行ったら", "行く", jaFinal, jaV5)
	add("いって", "いく", jaTe, jaV5)
	add("いった", "いく", jaFinal, jaV5)

	verb("る", jaV1, "", "", "て", "た", "られる", "られる", "させる", "よう", "れば", "ろ")
	add("れる", "る", jaV1, jaV1) // ら抜き potential
	add("よ", "る", jaFinal, jaV1)
	add("", "る", jaFinal, jaV1) // masu stem / continuative form

	verb("する", jaVS, "し", "し", "して", "した", "", "される", "させる", "しよう", "すれば", "しろ")
	add("せず", "する", jaFinal, jaVS)
	add("せよ", "する", jaFinal, jaVS)
	add("できる", "する", jaV1, jaVS)
	add("する", "", jaVS, jaNoun)

	verb("くる", jaVK, "き", "こ", "きて", "きた", "こられる", "こられる", "こさせる", "こよう", "くれば", "こい")
	verb("来る", jaVK, "来", "来", "来て", "来た", "来られる", "来られる", "来させる", "来よう", "来れば", "来い")

	add("く", "い", jaFinal, jaAdjI)
	add("くて", "い", jaTe|jaFinal, jaAdjI)
	add("かった", "い", jaFinal, jaAdjI)
	add("かったら", "い", jaFinal, jaAdjI)
	add("くない", "い", jaAdjI, jaAdjI)
	add("ければ", "い", jaFinal, jaAdjI)
	add("かろう", "い", jaFinal, jaAdjI)
	add("さ", "い", jaFinal, jaAdjI)
	add("そう", "い", jaFinal, jaAdjI)
	add("すぎる", "い", jaV1, jaAdjI)
	add("くなる", "い", jaV5, jaAdjI)

	add("ている", "て", jaV1, jaTe)
	add("てる", "て", jaV1, jaTe)
	add("でいる", "で", jaV1, jaTe)
	add("でる", "で", jaV1, jaTe)
	add("てしまう", "て", jaV5, jaTe)
	add("でしまう", "で", jaV5, jaTe)
	add("ちゃう", "て", jaV5, jaTe)
	add("じゃう", "で", jaV5, jaTe)
	add("ておく", "て", jaV5, jaTe)
	add("でおく", "で", jaV5, jaTe)
	add("てある", "て", jaV5, jaTe)
	add("てください", "て", jaFinal, jaTe)
	add("でください", "で", jaFinal, jaTe)

	add("です", "", jaFinal, jaAdjI|jaNoun)
	add("でした", "", jaFinal, jaAdjI|jaNoun)
	return rules
}

// deinflectJapanese returns possible dictionary forms of an inflected Japanese
// verb or i-adjective, e.g. 食べる for 食べました. Candidates are not checked against
// a dictionary and never include text itself.
func deinflectJapanese(text string) []string {
	type candidate struct {
		term  string
		class uint16
	}
	const maxDepth = 6
	rules := japaneseRules()
	seen := map[candidate]bool{{text, jaFinal}: true}
	queue := []candidate{{text, jaFinal}}
	var out []string
	emitted := map[string]bool{text: true}
	for depth := 0; depth < maxDepth && len(queue) > 0; depth++ {
		var next []candidate
		for _, current := range queue {
			for _, rule := range rules {
				if current.class == jaFinal {
					if current.term != text {
						continue
					}
				} else if current.class&rule.from == 0 {
					continue
				}
				stem, ok := strings.CutSuffix(current.term, rule.in)
				if !ok {
					continue
				}
				term := stem + rule.out
				if term == "" {
					continue
				}
				result := candidate{term, rule.to}
				if seen[result] {
					continue
				}
				seen[result] = true
				next = append(next, result)
				if !emitted[term] {
					emitted[term] = true
					out = append(out, term)
				}
			}
		}
		queue = next
	}
	return out
}
