package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"pandalibrary/internal/annotations"
	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
)

func TestAnnotationAssetHTTP(t *testing.T) {
	ctx := context.Background()
	databases := openHTTPTestDatabase(t)
	for _, statement := range []string{
		`INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES
			(1, 'first', 'x', 'admin', 1, 1), (2, 'second', 'x', 'user', 1, 1)`,
	} {
		if _, err := databases.Writer.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	cookies := make([]*http.Cookie, 2)
	for i := range cookies {
		token := strings.Repeat(string(rune('a'+i)), 43)
		digest := sha256.Sum256([]byte(token))
		now := time.Now().UnixMilli()
		if _, err := databases.Writer.Exec(`INSERT INTO sessions
			(token_hash, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
			VALUES (?, ?, ?, ?, ?, '', '')`, digest[:], i+1, now, now+3600000, now); err != nil {
			t.Fatal(err)
		}
		cookies[i] = &http.Cookie{Name: sessionCookieName, Value: token}
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	blobs, err := blobstore.New(directory)
	if err != nil {
		t.Fatal(err)
	}
	service, err := annotations.NewService(databases.Writer, databases.Reader, blobs)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	protection, err := CookieProtection(&url.URL{Scheme: "https", Host: "books.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	AnnotationAssetsMount(service, authentication, logger)(router, protection)
	request := func(method, path, media string, content []byte, cookie *http.Cookie, origin string, chunked bool) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, bytes.NewReader(content))
		req.Header.Set("Content-Type", media)
		req.Header.Set("Origin", origin)
		if chunked {
			req.ContentLength = -1
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	const endpoint = "/api/v1/me/annotation-assets"
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, image.NewNRGBA(image.Rect(0, 0, 3, 2))); err != nil {
		t.Fatal(err)
	}
	pngBytes := encoded.Bytes()
	bomb := bytes.Clone(pngBytes)
	binary.BigEndian.PutUint32(bomb[16:20], 8193)
	binary.BigEndian.PutUint32(bomb[29:33], crc32.ChecksumIEEE(bomb[12:29]))
	for _, test := range []struct {
		name, media string
		body        []byte
		status      int
		code        string
	}{
		{"unsupported", "image/svg+xml", []byte("<svg/>"), 415, "unsupported_media_type"},
		{"mismatch", "image/jpeg", pngBytes, 400, "invalid_image"},
		{"invalid", "image/png", []byte("invalid"), 400, "invalid_image"},
		{"truncated", "image/png", pngBytes[:16], 400, "invalid_image"},
		{"dimensions", "image/png", bomb, 400, "invalid_image_dimensions"},
		{"too large", "image/png", make([]byte, annotations.MaxBytes+1), 413, "asset_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, chunked := range []bool{false, true} {
				response := request("POST", endpoint, test.media, test.body, cookies[0], "https://books.example", chunked)
				if response.Code != test.status || !strings.Contains(response.Body.String(), `"`+test.code+`"`) {
					t.Fatalf("status = %d, body = %s", response.Code, response.Body)
				}
			}
		})
	}
	for _, method := range []string{"POST", "GET"} {
		path := endpoint
		if method == "GET" {
			path += "/" + strings.Repeat("a", 64)
		}
		response := request(method, path, "image/png", pngBytes, nil, "", false)
		if response.Code != 401 {
			t.Fatalf("unauthenticated %s = %d", method, response.Code)
		}
	}
	if response := request("POST", endpoint, "image/png", pngBytes, cookies[0], "https://evil.example", false); response.Code != 403 {
		t.Fatalf("cross-origin upload = %d", response.Code)
	}
	start := time.Now()
	// Valid PNG with trailing bytes exercises the exact 2 MiB raw transfer.
	content := append(bytes.Clone(pngBytes), make([]byte, (2<<20)-len(pngBytes))...)
	upload := request("POST", endpoint, "image/png", content, cookies[0], "https://books.example", false)
	var result struct {
		Asset annotations.Asset `json:"asset"`
	}
	if err := json.Unmarshal(upload.Body.Bytes(), &result); err != nil || upload.Code != 201 {
		t.Fatalf("upload = %d %s, %v", upload.Code, upload.Body, err)
	}
	digest := sha256.Sum256(content)
	if result.Asset.SHA256 != hex.EncodeToString(digest[:]) || result.Asset.Size != 2<<20 ||
		result.Asset.Width != 3 || result.Asset.Height != 2 || result.Asset.MediaType != "image/png" {
		t.Fatalf("wrong envelope: %+v", result.Asset)
	}
	path := endpoint + "/" + result.Asset.SHA256
	if response := request("GET", path, "", nil, cookies[1], "", false); response.Code != 404 {
		t.Fatalf("other user read = %d", response.Code)
	}
	for i, cookie := range []*http.Cookie{cookies[0], cookies[1]} {
		response := request("POST", endpoint, "image/png", content, cookie, "https://books.example", false)
		if response.Code != []int{200, 201}[i] {
			t.Fatalf("repeat/shared upload = %d %s", response.Code, response.Body)
		}
	}
	download := request("GET", path, "", nil, cookies[0], "", false)
	if download.Code != 200 || !bytes.Equal(download.Body.Bytes(), content) {
		t.Fatalf("download = %d (%d bytes)", download.Code, download.Body.Len())
	}
	t.Logf("2 MiB raw upload, deduplicated/shared re-uploads and download: %s", time.Since(start))
	for key, want := range map[string]string{
		"Cache-Control": "private, no-store", "Content-Type": "image/png", "Content-Length": "2097152",
		"X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; img-src 'self'",
	} {
		if got := download.Header().Get(key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
	if download.Header().Get("ETag") != "" {
		t.Fatal("private assets must not use HTTP cache validators")
	}
	var owners int
	if err := databases.Reader.QueryRow("SELECT count(*) FROM annotation_assets").Scan(&owners); err != nil || owners != 2 {
		t.Fatalf("owners = %d, %v", owners, err)
	}
	entries, err := os.ReadDir(filepath.Join(directory, "assets", result.Asset.SHA256[:2]))
	if err != nil || len(entries) != 1 {
		t.Fatalf("physical blobs = %v, %v", entries, err)
	}
	for _, hash := range []string{strings.Repeat("A", 64), "not-a-hash", "..%2fescape"} {
		response := request("GET", endpoint+"/"+hash, "", nil, cookies[0], "", false)
		if response.Code != 400 && response.Code != 404 {
			t.Errorf("invalid hash = %d", response.Code)
		}
	}
	var jpg bytes.Buffer
	if err := jpeg.Encode(&jpg, image.NewRGBA(image.Rect(0, 0, 1, 1)), nil); err != nil {
		t.Fatal(err)
	}
	if response := request("POST", endpoint, "image/jpeg", jpg.Bytes(), cookies[0], "https://books.example", false); response.Code != 201 {
		t.Fatalf("JPEG = %d %s", response.Code, response.Body)
	}
	webp, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA")
	if err != nil {
		t.Fatal(err)
	}
	if response := request("POST", endpoint, "image/webp", webp, cookies[0], "https://books.example", false); response.Code != 201 {
		t.Fatalf("WebP = %d %s", response.Code, response.Body)
	}
	boundary := append(bytes.Clone(pngBytes), make([]byte, annotations.MaxBytes-len(pngBytes))...)
	if response := request("POST", endpoint, "image/png", boundary, cookies[0], "https://books.example", true); response.Code != 201 {
		t.Fatalf("exact 5 MiB boundary = %d %s", response.Code, response.Body)
	}
}
