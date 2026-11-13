package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestPrivateLibraryCopyCanBeStagedWithoutExposingBookID(t *testing.T) {
	f, _ := bookheapFixture(t, 1<<20)
	data := heapEPUB(t, "private-existing")
	sum := sha256.Sum256([]byte(data))
	hash := hex.EncodeToString(sum[:])
	if _, err := f.db.Writer.Exec(`UPDATE books SET owner_id=2,visibility='private' WHERE id=101;
		UPDATE book_files SET sha256=? WHERE id=201`, hash); err != nil {
		t.Fatal(err)
	}
	response := f.heapUpload(t, uploadPart{name: "file", filename: "Duplicate.epub", data: data}, uploadPart{name: "visibility", data: "public"})
	defer response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("staging=%d", response.StatusCode)
	}
	var problem map[string]any
	if err := json.NewDecoder(response.Body).Decode(&problem); err != nil {
		t.Fatal(err)
	}
	if _, ok := problem["duplicate_of_book_id"]; ok {
		t.Fatalf("private duplicate leaked: %v", problem)
	}
	item, ok := problem["item"].(map[string]any)
	if !ok || item["status"] != "ready" || item["duplicate_of_book_id"] != nil {
		t.Fatalf("staged item exposed a library copy: %v", problem)
	}
	var owner int64
	var visibility string
	if err := f.db.Reader.QueryRow(`SELECT owner_id,visibility FROM books WHERE id=101`).Scan(&owner, &visibility); err != nil || owner != 2 || visibility != "private" {
		t.Fatalf("duplicate modified original: owner=%d visibility=%s err=%v", owner, visibility, err)
	}
}
