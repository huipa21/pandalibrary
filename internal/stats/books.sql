-- Files have no independent ACL: CatalogBookFiles uses the parent book's
-- visibility and hide-list predicate. Keep that same scope for every aggregate.
WITH visible_books AS (
    SELECT b.* FROM books b
    WHERE :user_id > 0
      AND (b.visibility = 'public' OR b.owner_id = :user_id
           OR (b.visibility = 'library' AND (:is_admin = 1 OR EXISTS (
               SELECT 1 FROM library_access la
               WHERE la.library_id = b.library_id AND la.user_id = :user_id
           ))))
      AND NOT EXISTS (
          SELECT 1 FROM book_hidden h WHERE h.book_id = b.id AND h.user_id = :user_id
      )
)
SELECT b.id, b.title, b.created_at, b.published_date, b.language, b.page_count,
       (SELECT SUM(f.size_bytes) FROM book_files f WHERE f.book_id = b.id),
       (SELECT json_group_array(name) FROM (
           SELECT a.name FROM book_authors ba JOIN authors a ON a.id = ba.author_id
           WHERE ba.book_id = b.id AND ba.role = 'author'
           ORDER BY ba.position, a.sort_name, a.id
       )),
       (SELECT json_group_array(name) FROM (
           SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
           WHERE bt.book_id = b.id ORDER BY t.name, t.id
       )),
       (SELECT json_group_array(format) FROM (
           SELECT DISTINCT f.format FROM book_files f WHERE f.book_id = b.id ORDER BY f.format
       ))
FROM visible_books b
ORDER BY b.id;
