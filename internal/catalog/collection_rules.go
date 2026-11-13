package catalog

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"regexp"

	"pandalibrary/internal/db/sqlc"
)

// RuleGroup is an independently named rule. Groups are ORed, in addition to
// manual shelf_books membership; each group's RuleSet retains its all/any semantics.
type RuleGroup struct {
	ID    string  `json:"id"`
	Name  string  `json:"name"`
	Rules RuleSet `json:"rules"`
}

var ruleGroupIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)

func normalizeRuleGroups(groups []RuleGroup) ([]RuleGroup, string, error) {
	if len(groups) > 20 {
		return nil, "", invalid("a collection may have at most 20 rule groups")
	}
	result := make([]RuleGroup, 0, len(groups))
	seen := make(map[string]bool, len(groups))
	for _, group := range groups {
		if !ruleGroupIDPattern.MatchString(group.ID) || seen[group.ID] {
			return nil, "", invalid("rule group IDs must be unique and contain 1-100 ASCII letters, digits, underscores or hyphens")
		}
		seen[group.ID] = true
		name, err := validateName(group.Name, "rule group name")
		if err != nil {
			return nil, "", err
		}
		rules, _, err := normalizeRules(group.Rules)
		if err != nil {
			return nil, "", err
		}
		result = append(result, RuleGroup{ID: group.ID, Name: name, Rules: rules})
	}
	stored, err := json.Marshal(result)
	if err != nil {
		return nil, "", fmt.Errorf("encode collection rule groups: %w", err)
	}
	return result, string(stored), nil
}

// Retention snapshots only the acting viewer's current matches. No owner's reading
// state or hidden membership is materialized into a shared collection.
func retainRemovedRuleBooks(ctx context.Context, queries *sqlc.Queries, viewer Viewer, shelf sqlc.Shelf, groups []RuleGroup, now int64) error {
	var previous []RuleGroup
	if err := json.Unmarshal([]byte(shelf.RuleGroups), &previous); err != nil {
		return fmt.Errorf("decode collection rule groups: %w", err)
	}
	remaining := make(map[string]bool, len(groups))
	for _, group := range groups {
		remaining[group.ID] = true
	}
	removed := make([]RuleGroup, 0, len(previous))
	for _, group := range previous {
		if !remaining[group.ID] {
			removed = append(removed, group)
		}
	}
	if len(removed) == 0 {
		return nil
	}
	_, stored, err := normalizeRuleGroups(removed)
	if err != nil {
		return err
	}
	ids, err := queries.ShelfRuleMatchingBookIDs(ctx, sqlc.ShelfRuleMatchingBookIDsParams{
		RuleGroups: stored, IsAdmin: adminFlag(viewer), UserID: viewer.UserID,
	})
	if err != nil {
		return fmt.Errorf("find removed rule matches: %w", err)
	}
	members, err := orderedShelfMembers(ctx, queries, viewer, shelf.ID)
	if err != nil {
		return err
	}
	manual := make(map[int64]bool, len(members))
	var position int64
	for _, member := range members {
		manual[member.BookID] = true
		if member.Position >= position {
			position = member.Position + 1
		}
	}
	for _, id := range ids {
		if manual[id] {
			continue
		}
		if err := queries.ShelfInsertBook(ctx, sqlc.ShelfInsertBookParams{
			ShelfID: shelf.ID, BookID: id, Position: position,
			AddedBy: sql.NullInt64{Int64: viewer.UserID, Valid: true}, AddedAt: now,
		}); err != nil {
			return fmt.Errorf("retain removed rule book: %w", err)
		}
		position++
	}
	return nil
}
