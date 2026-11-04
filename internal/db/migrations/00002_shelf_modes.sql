-- +goose Up

-- UX2: manual/automatic shelf modes, per-account system shelves, and rule storage.
-- `kind` stays private/shared; `mode` is the orthogonal manual/automatic choice.
ALTER TABLE shelves ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual'
    CHECK (mode IN ('manual', 'automatic'));
ALTER TABLE shelves ADD COLUMN system_key TEXT
    CHECK (system_key IS NULL OR (system_key = 'favorites' AND kind = 'private' AND mode = 'manual'));
-- Canonical RuleSet JSON written by the catalog service; present only on private automatic shelves.
ALTER TABLE shelves ADD COLUMN rules TEXT
    CHECK ((rules IS NOT NULL) = (mode = 'automatic')
        AND (rules IS NULL OR (kind = 'private' AND json_valid(rules))));

-- System shelves are identified by system_key, never by name, so a custom shelf that is
-- already called "Favorites" keeps its name and data.
DROP INDEX shelves_private_name;
CREATE UNIQUE INDEX shelves_private_name ON shelves (owner_id, name COLLATE NOCASE)
    WHERE kind = 'private' AND system_key IS NULL;
CREATE UNIQUE INDEX shelves_system_key ON shelves (owner_id, system_key) WHERE system_key IS NOT NULL;

-- Provision Favorites once for every existing account. New accounts are provisioned
-- idempotently by the catalog service before their first shelf read.
INSERT OR IGNORE INTO shelves (kind, owner_id, name, description, created_by, created_at, updated_at, mode, system_key)
SELECT 'private', u.id, 'Favorites', NULL, u.id,
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
    'manual', 'favorites'
FROM users u
ORDER BY u.id;

-- +goose Down

-- Development rollback only: system and automatic shelves cannot be represented by v1.
DELETE FROM shelves WHERE system_key IS NOT NULL OR mode = 'automatic';
DROP INDEX shelves_system_key;
DROP INDEX shelves_private_name;
ALTER TABLE shelves DROP COLUMN rules;
ALTER TABLE shelves DROP COLUMN system_key;
ALTER TABLE shelves DROP COLUMN mode;
CREATE UNIQUE INDEX shelves_private_name ON shelves (owner_id, name COLLATE NOCASE) WHERE kind = 'private';
