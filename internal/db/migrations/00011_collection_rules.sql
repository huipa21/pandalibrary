-- +goose Up

-- Membership in shelf_books is manual provenance. Rule provenance is evaluated live
-- for each viewer, so shared collections never expose another account's hidden books.
ALTER TABLE shelves ADD COLUMN rule_groups TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(rule_groups) AND json_type(rule_groups) = 'array');
UPDATE shelves
SET rule_groups = json_array(json_object('id', 'legacy', 'name', 'Rules', 'rules', json(rules)))
WHERE mode = 'automatic';

-- +goose Down

ALTER TABLE shelves DROP COLUMN rule_groups;
