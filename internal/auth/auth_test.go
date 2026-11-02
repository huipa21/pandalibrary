package auth

import (
	"context"
	"crypto/md5"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/db/sqlc"

	"golang.org/x/crypto/argon2"
)

func TestPasswordHashAndSemaphore(t *testing.T) {
	manager := newPasswordManager()
	encoded, err := manager.hash(context.Background(), "correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$m=65536,t=3,p=4$") {
		t.Fatalf("hash has unexpected PHC parameters: %q", encoded)
	}
	valid, err := manager.verify(context.Background(), "correct horse battery", encoded)
	if err != nil || !valid {
		t.Fatalf("valid password verification = %v, %v", valid, err)
	}
	valid, err = manager.verify(context.Background(), "incorrect password", encoded)
	if err != nil || valid {
		t.Fatalf("invalid password verification = %v, %v", valid, err)
	}
	if !manager.needsRehash("$argon2id$v=19$m=32768,t=2,p=2$MDEyMzQ1Njc4OWFiY2RlZg$MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3") {
		t.Fatal("older Argon2 parameters should require rehash")
	}

	manager.slots <- struct{}{}
	manager.slots <- struct{}{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := manager.hash(ctx, "correct horse battery"); !errors.Is(err, context.Canceled) {
		t.Fatalf("hash while semaphore is saturated = %v, want context cancellation", err)
	}
}

func TestRateLimiterBoundAndReset(t *testing.T) {
	limiter := NewRateLimiter()
	now := time.Now()
	for i := 0; i < authRateMax; i++ {
		if !limiter.Allow("client", now) {
			t.Fatalf("attempt %d unexpectedly rejected", i+1)
		}
	}
	if limiter.Allow("client", now) {
		t.Fatal("attempt beyond limit was accepted")
	}
	limiter.Reset("client")
	if !limiter.Allow("client", now) {
		t.Fatal("successful-login reset did not clear the limit")
	}
	if limiter.Allow("client", now.Add(authRateWindow)) != true {
		t.Fatal("expired entry was not cleared")
	}
	limiter = NewRateLimiter()
	for i := 0; i < authRateMaxIPs; i++ {
		if !limiter.Allow(fmt.Sprintf("client-%d", i), now) {
			t.Fatalf("client %d unexpectedly rejected before the state limit", i)
		}
	}
	if limiter.Allow("new-client", now) {
		t.Fatal("rate limiter exceeded its bounded state")
	}
}

func TestSetupLoginSessionsAndAppPasswords(t *testing.T) {
	ctx := context.Background()
	databases := testDatabases(t)
	service, err := NewService(ctx, databases.Writer, databases.Reader, true)
	if err != nil {
		t.Fatal(err)
	}
	token := service.InitialSetupToken()
	if token == "" {
		t.Fatal("first-run service did not create a setup token")
	}
	user, err := service.CreateInitialAdmin(ctx, token, CreateUserInput{
		Username: "admin", DisplayName: "Library Admin", Password: "correct horse battery", Locale: "zh",
	})
	if err != nil {
		t.Fatal(err)
	}
	if user.Role != "admin" || user.Locale != "zh" || user.Disabled {
		t.Fatalf("created user = %+v", user)
	}
	if _, err := service.CreateInitialAdmin(ctx, token, CreateUserInput{
		Username: "second", Password: "another correct password",
	}); !errors.Is(err, ErrInvalidSetupToken) {
		t.Fatalf("reused setup token error = %v", err)
	}

	session, err := service.Login(ctx, "ADMIN", "correct horse battery", "test-agent", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if !validSessionToken(session.Token) || time.Until(session.ExpiresAt) < 29*24*time.Hour {
		t.Fatalf("unexpected session: %+v", session)
	}
	authenticated, err := service.Authenticate(ctx, session.Token)
	if err != nil || authenticated.ID != user.ID {
		t.Fatalf("Authenticate() = %+v, %v", authenticated, err)
	}
	if err := service.ResetPassword(ctx, "admin", "another correct password"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Authenticate(ctx, session.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("session survived password reset: %v", err)
	}
	if _, err := service.Login(ctx, "admin", "correct horse battery", "", ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("old password login error = %v", err)
	}

	session, err = service.Login(ctx, "admin", "another correct password", "", "")
	if err != nil {
		t.Fatal(err)
	}
	opds, err := service.CreateAppPassword(ctx, user.ID, "opds", "Kindle")
	if err != nil {
		t.Fatal(err)
	}
	if len(strings.ReplaceAll(opds.Secret, "-", "")) != 16 || strings.Count(opds.Secret, "-") != 3 {
		t.Fatalf("generated app password has invalid display format: %q", opds.Secret)
	}
	if verified, err := service.VerifyAppPassword(ctx, "admin", "opds", opds.Secret); err != nil || verified.ID != user.ID {
		t.Fatalf("OPDS app-password verification = %+v, %v", verified, err)
	}
	if _, err := service.VerifyAppPassword(ctx, "other", "opds", opds.Secret); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("wrong-user app password error = %v", err)
	}
	kosync, err := service.CreateAppPassword(ctx, user.ID, "kosync", "Reader")
	if err != nil {
		t.Fatal(err)
	}
	secret := strings.ReplaceAll(kosync.Secret, "-", "")
	md5Value := fmt.Sprintf("%x", md5Sum([]byte(secret)))
	if verified, err := service.VerifyAppPassword(ctx, "admin", "kosync", md5Value); err != nil || verified.ID != user.ID {
		t.Fatalf("KOReader app-password verification = %+v, %v", verified, err)
	}
	listed, err := service.ListAppPasswords(ctx, user.ID)
	if err != nil || len(listed) != 2 || listed[0].Secret != "" || listed[1].Secret != "" {
		t.Fatalf("listed app passwords = %+v, %v", listed, err)
	}
	if err := service.RevokeAppPassword(ctx, user.ID, opds.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.VerifyAppPassword(ctx, "admin", "opds", opds.Secret); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("revoked credential verification error = %v", err)
	}
	if err := service.SetDisabled(ctx, user.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Authenticate(ctx, session.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("disabled user session error = %v", err)
	}
	if _, err := service.VerifyAppPassword(ctx, "admin", "kosync", md5Value); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("disabled user app-password error = %v", err)
	}
	if err := service.Logout(ctx, session.Token); err != nil {
		t.Fatalf("idempotent logout: %v", err)
	}
}

func TestFirstCLIUserMustBeAdministrator(t *testing.T) {
	ctx := context.Background()
	databases := testDatabases(t)
	service, err := NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateUser(ctx, CreateUserInput{
		Username: "reader", Password: "correct horse battery",
	}); !errors.Is(err, ErrFirstUserMustAdmin) {
		t.Fatalf("first regular-user creation error = %v", err)
	}
}

func TestLoginRehashesOlderPasswordParameters(t *testing.T) {
	ctx := context.Background()
	databases := testDatabases(t)
	service, err := NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	user, err := service.CreateUser(ctx, CreateUserInput{
		Username: "reader", Password: "correct horse battery", Role: "admin",
	})
	if err != nil {
		t.Fatal(err)
	}
	salt := []byte("0123456789abcdef")
	key := argon2.IDKey([]byte("correct horse battery"), salt, 2, 32*1024, 2, passwordKeyBytes)
	olderHash := fmt.Sprintf("$argon2id$v=19$m=32768,t=2,p=2$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
	if err := sqlc.New(databases.Writer).AuthUpdatePassword(ctx, sqlc.AuthUpdatePasswordParams{
		PasswordHash: olderHash, UpdatedAt: time.Now().UnixMilli(), ID: user.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Login(ctx, user.Username, "correct horse battery", "", ""); err != nil {
		t.Fatal(err)
	}
	updated, err := sqlc.New(databases.Reader).AuthGetUserByID(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(updated.PasswordHash, "$argon2id$v=19$m=65536,t=3,p=4$") {
		t.Fatalf("successful login did not upgrade password hash: %q", updated.PasswordHash)
	}
	if _, err := service.Login(ctx, "missing-user", "correct horse battery", "", ""); !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("unknown-user login error = %v", err)
	}
}

func TestSessionSlidesAtMostHourlyAndExpires(t *testing.T) {
	ctx := context.Background()
	databases := testDatabases(t)
	service, err := NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	if _, err := service.CreateInitialAdmin(ctx, service.InitialSetupToken(), CreateUserInput{
		Username: "admin", Password: "correct horse battery",
	}); err != nil {
		t.Fatal(err)
	}
	session, err := service.Login(ctx, "admin", "correct horse battery", "", "")
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Minute)
	if _, err := service.Authenticate(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	var lastSeen, expires int64
	if err := databases.Reader.QueryRow(
		"SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?", hashToken(session.Token),
	).Scan(&lastSeen, &expires); err != nil {
		t.Fatal(err)
	}
	if lastSeen != session.ExpiresAt.Add(-sessionLifetime).UnixMilli() {
		t.Fatalf("session touched before one hour: %d", lastSeen)
	}
	now = now.Add(45 * time.Minute)
	if _, err := service.Authenticate(ctx, session.Token); err != nil {
		t.Fatal(err)
	}
	if err := databases.Reader.QueryRow(
		"SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = ?", hashToken(session.Token),
	).Scan(&lastSeen, &expires); err != nil {
		t.Fatal(err)
	}
	if lastSeen != now.UnixMilli() || expires != now.Add(sessionLifetime).UnixMilli() {
		t.Fatalf("session was not slid at the hourly boundary: last seen %d, expiry %d", lastSeen, expires)
	}
	now = time.UnixMilli(expires).Add(time.Millisecond)
	if _, err := service.Authenticate(ctx, session.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("expired session authentication error = %v", err)
	}
}

func TestConcurrentSetupCreatesOnlyOneAdministrator(t *testing.T) {
	ctx := context.Background()
	databases := testDatabases(t)
	service, err := NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	token := service.InitialSetupToken()
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, username := range []string{"admin-one", "admin-two"} {
		username := username
		go func() {
			<-start
			_, err := service.CreateInitialAdmin(ctx, token, CreateUserInput{
				Username: username, Password: "correct horse battery",
			})
			results <- err
		}()
	}
	close(start)
	successes := 0
	for range 2 {
		err := <-results
		if err == nil {
			successes++
		} else if !errors.Is(err, ErrSetupComplete) && !errors.Is(err, ErrInvalidSetupToken) {
			t.Fatalf("concurrent setup returned unexpected error: %v", err)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent setup succeeded %d times, want exactly once", successes)
	}
	count, err := sqlc.New(databases.Reader).AuthCountUsers(ctx)
	if err != nil || count != 1 {
		t.Fatalf("user count after concurrent setup = %d, %v", count, err)
	}
}

func testDatabases(t *testing.T) *db.DB {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pandalibrary.db")
	ctx := context.Background()
	databases, err := db.Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := databases.Close(); err != nil {
			t.Errorf("close test database: %v", err)
		}
	})
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(ctx); err != nil {
		t.Fatal(err)
	}
	return databases
}

func md5Sum(value []byte) []byte {
	sum := md5.Sum(value)
	return sum[:]
}
