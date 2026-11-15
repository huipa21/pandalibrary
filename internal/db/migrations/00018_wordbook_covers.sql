-- +goose Up
ALTER TABLE wordbooks ADD COLUMN cover_color TEXT NOT NULL DEFAULT '' CHECK(cover_color IN ('', 'navy', 'forest', 'ochre', 'khaki', 'rust', 'taupe', 'burgundy', 'slate-teal'));
ALTER TABLE wordbooks ADD COLUMN cover_image TEXT NOT NULL DEFAULT '' CHECK(length(cover_image) <= 819223);

-- +goose Down
ALTER TABLE wordbooks DROP COLUMN cover_image;
ALTER TABLE wordbooks DROP COLUMN cover_color;
