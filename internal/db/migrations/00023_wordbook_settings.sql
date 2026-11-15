-- +goose Up
ALTER TABLE wordbooks ADD COLUMN meaning_languages TEXT NOT NULL DEFAULT '[]'
    CHECK(json_valid(meaning_languages) AND json_type(meaning_languages) = 'array' AND json_array_length(meaning_languages) <= 20 AND length(meaning_languages) <= 761);
UPDATE wordbooks SET meaning_languages = json_array(meaning_language) WHERE meaning_language <> '';
ALTER TABLE wordbooks ADD COLUMN cover_color_new TEXT NOT NULL DEFAULT '' CHECK(cover_color_new IN ('', 'navy', 'forest', 'ochre', 'khaki', 'rust', 'taupe', 'burgundy', 'slate-teal', 'crimson', 'coral', 'orange', 'amber', 'olive', 'emerald', 'turquoise', 'sky', 'cobalt', 'violet', 'plum', 'charcoal'));
UPDATE wordbooks SET cover_color_new = cover_color;
ALTER TABLE wordbooks DROP COLUMN cover_color;
ALTER TABLE wordbooks RENAME COLUMN cover_color_new TO cover_color;

-- +goose Down
ALTER TABLE wordbooks ADD COLUMN cover_color_old TEXT NOT NULL DEFAULT '' CHECK(cover_color_old IN ('', 'navy', 'forest', 'ochre', 'khaki', 'rust', 'taupe', 'burgundy', 'slate-teal'));
UPDATE wordbooks SET cover_color_old = CASE WHEN cover_color IN ('navy', 'forest', 'ochre', 'khaki', 'rust', 'taupe', 'burgundy', 'slate-teal') THEN cover_color ELSE '' END;
ALTER TABLE wordbooks DROP COLUMN cover_color;
ALTER TABLE wordbooks RENAME COLUMN cover_color_old TO cover_color;
ALTER TABLE wordbooks DROP COLUMN meaning_languages;
