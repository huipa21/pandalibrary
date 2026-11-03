package kosync

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"time"
)

// Server session UUIDv7s keep a stable device/document hash in the random bits.
// This retains device identity across restarts without changing the shared schema.
func sessionID(userID int64, target file, record Record, now int64) string {
	identity := record.DeviceID
	if identity == "" {
		identity = record.Device
	}
	sum := sha256.Sum256([]byte(fmt.Sprintf("%d:%d:%s:%s", userID, target.id, record.Document, identity)))
	var id [16]byte
	binary.BigEndian.PutUint64(id[:8], uint64(now)<<16)
	copy(id[6:], sum[:10])
	id[6] = id[6]&0x0f | 0x70
	id[8] = id[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:])
}

func extendSession(ctx context.Context, tx *sql.Tx, userID int64, target file, record Record, now int64) error {
	id := sessionID(userID, target, record, now)
	var previousID string
	var endedAt int64
	err := tx.QueryRowContext(ctx, `SELECT id, ended_at FROM reading_sessions
		WHERE user_id = ? AND book_id = ? AND source = 'koreader' AND substr(id, 15) = ?
		ORDER BY ended_at DESC, seq DESC LIMIT 1`, userID, target.bookID, id[14:]).Scan(&previousID, &endedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("find KOReader session: %w", err)
	}
	if err == nil && now >= endedAt && now-endedAt <= (15*time.Minute).Milliseconds() {
		_, err = tx.ExecContext(ctx, `UPDATE reading_sessions SET ended_at = ?, device = ?,
			active_seconds = (? - started_at) / 1000, end_percentage = ? WHERE id = ?`,
			now, record.Device, now, record.Percentage, previousID)
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO reading_sessions
			(id, user_id, book_id, source, device, started_at, ended_at, active_seconds,
			 start_percentage, end_percentage, created_at) VALUES (?, ?, ?, 'koreader', ?, ?, ?, 0, ?, ?, ?)`,
			id, userID, target.bookID, record.Device, now, now, record.Percentage, record.Percentage, now)
	}
	if err != nil {
		return fmt.Errorf("write KOReader session: %w", err)
	}
	return nil
}
