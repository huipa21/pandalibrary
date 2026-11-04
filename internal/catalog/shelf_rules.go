package catalog

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	ShelfModeManual    = "manual"
	ShelfModeAutomatic = "automatic"

	SystemShelfFavorites = "favorites"
	SystemShelfUnshelved = "unshelved"

	maxRuleConditions  = 20
	maxRuleTitleRunes  = 200
	maxRuleLanguageLen = 35
)

var (
	ruleLanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`)
	ruleFormats         = map[string]bool{
		"epub": true, "pdf": true, "mobi": true, "azw3": true, "fb2": true, "fbz": true, "cbz": true,
	}
	ruleStatuses = map[string]bool{
		"unread": true, "want_to_read": true, "reading": true, "finished": true, "abandoned": true,
	}
)

// RuleSet is a flat automatic-shelf rule list. Match is "all" or "any".
type RuleSet struct {
	Match      string          `json:"match"`
	Conditions []RuleCondition `json:"conditions"`
}

// RuleCondition compares one book field. Value is a JSON string or positive integer
// depending on Field; see docs/architecture/ux2-shelves.md for semantics.
type RuleCondition struct {
	Field string          `json:"field"`
	Op    string          `json:"op"`
	Value json.RawMessage `json:"value"`
}

// normalizeRules validates a RuleSet and returns it with canonical JSON values plus
// the canonical stored JSON text.
func normalizeRules(rules RuleSet) (RuleSet, string, error) {
	if rules.Match != "all" && rules.Match != "any" {
		return RuleSet{}, "", invalid(`rules match must be "all" or "any"`)
	}
	if len(rules.Conditions) < 1 || len(rules.Conditions) > maxRuleConditions {
		return RuleSet{}, "", invalid("rules must have between 1 and 20 conditions")
	}
	result := RuleSet{Match: rules.Match, Conditions: make([]RuleCondition, 0, len(rules.Conditions))}
	for index, condition := range rules.Conditions {
		value, err := normalizeRuleCondition(condition)
		if err != nil {
			return RuleSet{}, "", fmt.Errorf("%w (condition %d)", err, index+1)
		}
		result.Conditions = append(result.Conditions, RuleCondition{Field: condition.Field, Op: condition.Op, Value: value})
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return RuleSet{}, "", fmt.Errorf("encode shelf rules: %w", err)
	}
	return result, string(encoded), nil
}

func normalizeRuleCondition(condition RuleCondition) (json.RawMessage, error) {
	switch condition.Field {
	case "title":
		if condition.Op != "contains" {
			return nil, invalid(`title conditions require op "contains"`)
		}
	case "author_id", "tag_id", "series_id", "language", "format", "reading_status":
		if condition.Op != "eq" {
			return nil, invalid(fmt.Sprintf(`%s conditions require op "eq"`, condition.Field))
		}
	default:
		return nil, invalid("rule field is not supported")
	}
	switch condition.Field {
	case "author_id", "tag_id", "series_id":
		id, ok := ruleInteger(condition.Value)
		if !ok {
			return nil, invalid(fmt.Sprintf("%s value must be a positive integer", condition.Field))
		}
		return json.RawMessage(strconv.FormatInt(id, 10)), nil
	}
	text, ok := ruleString(condition.Value)
	if !ok {
		return nil, invalid(fmt.Sprintf("%s value must be a string", condition.Field))
	}
	switch condition.Field {
	case "title":
		if strings.TrimSpace(text) == "" || utf8.RuneCountInString(text) > maxRuleTitleRunes ||
			strings.IndexFunc(text, unicode.IsControl) >= 0 {
			return nil, invalid("title value must be 1-200 characters without control characters")
		}
	case "language":
		if len(text) > maxRuleLanguageLen || !ruleLanguagePattern.MatchString(text) {
			return nil, invalid("language value must be a BCP 47 language tag")
		}
	case "format":
		if !ruleFormats[text] {
			return nil, invalid("format value is not supported")
		}
	case "reading_status":
		if !ruleStatuses[text] {
			return nil, invalid("reading_status value is not supported")
		}
	}
	encoded, err := json.Marshal(text)
	if err != nil {
		return nil, invalid("rule value is invalid")
	}
	return encoded, nil
}

func ruleInteger(raw json.RawMessage) (int64, bool) {
	raw = bytes.TrimSpace(raw)
	// Only plain JSON integers; reject strings, fractions, exponents, and signs.
	if len(raw) == 0 || len(raw) > 19 || raw[0] < '1' || raw[0] > '9' {
		return 0, false
	}
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, false
		}
	}
	id, err := strconv.ParseInt(string(raw), 10, 64)
	return id, err == nil && id > 0
}

func ruleString(raw json.RawMessage) (string, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) < 2 || raw[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || !utf8.ValidString(text) {
		return "", false
	}
	return text, true
}

// decodeStoredRules parses canonical rules written by normalizeRules.
func decodeStoredRules(stored string) (*RuleSet, error) {
	var rules RuleSet
	if err := json.Unmarshal([]byte(stored), &rules); err != nil {
		return nil, fmt.Errorf("decode stored shelf rules: %w", err)
	}
	return &rules, nil
}

func rulesSignature(stored string) string {
	sum := sha256.Sum256([]byte(stored))
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}
