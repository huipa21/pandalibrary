package auth

import (
	"context"
	"crypto/md5"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

var (
	ErrInvalidCredentials = errors.New("invalid credentials")
	ErrInvalidSession     = errors.New("invalid session")
	ErrInvalidSetupToken  = errors.New("invalid setup token")
	ErrSetupComplete      = errors.New("initial setup is already complete")
	ErrUserNotFound       = errors.New("user not found")
	ErrUsernameTaken      = errors.New("username is already in use")
	ErrFirstUserMustAdmin = errors.New("the first user must be an administrator")
	ErrInvalidUser        = errors.New("invalid user")
	ErrAppPasswordMissing = errors.New("app password not found")
)

const (
	sessionLifetime = 30 * 24 * time.Hour
	sessionTouchAge = time.Hour
)

// User is the safe identity exposed to HTTP handlers and later domain packages.
type User struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Locale      string `json:"locale"`
	Disabled    bool   `json:"-"`
}

// CreateUserInput contains validated fields for a new account.
type CreateUserInput struct {
	Username    string
	DisplayName string
	Password    string
	Role        string
	Locale      string
}

// Session contains the raw cookie token only until the HTTP layer writes it.
type Session struct {
	User      User
	Token     string
	ExpiresAt time.Time
}

// AppPassword is safe to return in list responses. Secret is populated only on creation.
type AppPassword struct {
	ID         int64      `json:"id"`
	Kind       string     `json:"kind"`
	Label      string     `json:"label"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty"`
	Secret     string     `json:"secret,omitempty"`
}

// Service owns the database-backed identity and credential operations.
type Service struct {
	writer       *sql.DB
	reader       *sql.DB
	passwords    *passwordManager
	secureCookie bool
	loginLimiter *RateLimiter
	setupLimiter *RateLimiter
	setupMu      sync.Mutex
	setupToken   string
	now          func() time.Time
}

// NewService initializes authentication against the migrated database. It creates a
// one-time setup token only when no users exist.
func NewService(ctx context.Context, writer, reader *sql.DB, secureCookie bool) (*Service, error) {
	if writer == nil || reader == nil {
		return nil, errors.New("authentication requires writer and reader databases")
	}
	service := &Service{
		writer: writer, reader: reader, passwords: newPasswordManager(),
		secureCookie: secureCookie, loginLimiter: NewRateLimiter(), setupLimiter: NewRateLimiter(), now: time.Now,
	}
	count, err := sqlc.New(reader).AuthCountUsers(ctx)
	if err != nil {
		return nil, fmt.Errorf("count users for first-run setup: %w", err)
	}
	if count == 0 {
		var random [32]byte
		if _, err := rand.Read(random[:]); err != nil {
			return nil, fmt.Errorf("generate initial setup token: %w", err)
		}
		service.setupToken = base64.RawURLEncoding.EncodeToString(random[:])
	}
	return service, nil
}

// InitialSetupToken returns the one-time token for startup logging, if setup is pending.
func (s *Service) InitialSetupToken() string {
	s.setupMu.Lock()
	defer s.setupMu.Unlock()
	return s.setupToken
}

// SecureCookie reports whether session cookies should be marked Secure.
func (s *Service) SecureCookie() bool {
	return s.secureCookie
}

// AllowLoginAttempt records a login attempt against the resolved client address.
func (s *Service) AllowLoginAttempt(clientIP string) bool {
	return s.loginLimiter.Allow(clientIP, s.now())
}

// ResetLoginAttempts clears a client's failed-attempt counter after a successful login.
func (s *Service) ResetLoginAttempts(clientIP string) {
	s.loginLimiter.Reset(clientIP)
}

// AllowSetupAttempt records a first-run setup attempt against the resolved client address.
func (s *Service) AllowSetupAttempt(clientIP string) bool {
	return s.setupLimiter.Allow(clientIP, s.now())
}

// SetupRequired reports whether the users table is empty.
func (s *Service) SetupRequired(ctx context.Context) (bool, error) {
	count, err := sqlc.New(s.reader).AuthCountUsers(ctx)
	if err != nil {
		return false, fmt.Errorf("count users: %w", err)
	}
	return count == 0, nil
}

// CreateInitialAdmin validates the one-time token and atomically creates the first admin.
func (s *Service) CreateInitialAdmin(ctx context.Context, token string, input CreateUserInput) (User, error) {
	s.setupMu.Lock()
	expected := s.setupToken
	s.setupMu.Unlock()
	if expected == "" || len(expected) != len(token) ||
		subtle.ConstantTimeCompare([]byte(expected), []byte(token)) != 1 {
		return User{}, ErrInvalidSetupToken
	}
	input.Role = "admin"
	input, err := normalizeUserInput(input)
	if err != nil {
		return User{}, err
	}
	passwordHash, err := s.passwords.hash(ctx, input.Password)
	if err != nil {
		return User{}, err
	}
	var created sqlc.User
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		count, err := queries.AuthCountUsers(ctx)
		if err != nil {
			return fmt.Errorf("check first-run setup state: %w", err)
		}
		if count != 0 {
			return ErrSetupComplete
		}
		created, err = queries.AuthCreateUser(ctx, sqlc.AuthCreateUserParams{
			Username: input.Username, DisplayName: input.DisplayName, PasswordHash: passwordHash,
			Role: "admin", Locale: input.Locale, CreatedAt: s.now().UnixMilli(), UpdatedAt: s.now().UnixMilli(),
		})
		if err != nil {
			return fmt.Errorf("create initial administrator: %w", err)
		}
		return nil
	})
	if err != nil {
		return User{}, err
	}
	s.setupMu.Lock()
	s.setupToken = ""
	s.setupMu.Unlock()
	return safeUser(created), nil
}

// CreateUser creates an account for the local administration CLI.
func (s *Service) CreateUser(ctx context.Context, input CreateUserInput) (User, error) {
	input, err := normalizeUserInput(input)
	if err != nil {
		return User{}, err
	}
	passwordHash, err := s.passwords.hash(ctx, input.Password)
	if err != nil {
		return User{}, err
	}
	var created sqlc.User
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		var err error
		created, err = s.createUser(ctx, sqlc.New(tx), input, passwordHash)
		return err
	})
	if err != nil {
		return User{}, err
	}
	return safeUser(created), nil
}

// ResetPassword replaces a password and revokes all browser and app credentials.
func (s *Service) ResetPassword(ctx context.Context, username, password string) error {
	user, err := sqlc.New(s.reader).AuthGetUserByUsername(ctx, strings.TrimSpace(username))
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUserNotFound
	}
	if err != nil {
		return fmt.Errorf("find user for password reset: %w", err)
	}
	passwordHash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return err
	}
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		current, err := queries.AuthGetUserByUsername(ctx, strings.TrimSpace(username))
		if errors.Is(err, sql.ErrNoRows) || (err == nil && current.ID != user.ID) {
			return ErrUserNotFound
		}
		if err != nil {
			return fmt.Errorf("find user for password reset: %w", err)
		}
		return s.resetPassword(ctx, queries, user.ID, passwordHash)
	})
}

// SetDisabled changes the account's disabled state and revokes all credentials when disabling.
func (s *Service) SetDisabled(ctx context.Context, userID int64, disabled bool) error {
	now := s.now().UnixMilli()
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		if _, err := queries.AuthGetUserByID(ctx, userID); errors.Is(err, sql.ErrNoRows) {
			return ErrUserNotFound
		} else if err != nil {
			return fmt.Errorf("find user to update disabled state: %w", err)
		}
		value := int64(0)
		if disabled {
			value = 1
		}
		if err := queries.AuthSetUserDisabled(ctx, sqlc.AuthSetUserDisabledParams{
			Disabled: value, UpdatedAt: now, ID: userID,
		}); err != nil {
			return fmt.Errorf("update user disabled state: %w", err)
		}
		if disabled {
			return revokeCredentials(ctx, queries, userID)
		}
		return nil
	})
}

// Login validates credentials and creates a database-backed browser session.
func (s *Service) Login(ctx context.Context, username, password, userAgent, ip string) (Session, error) {
	username = strings.TrimSpace(username)
	if len(password) > maxPasswordBytes {
		return Session{}, ErrInvalidCredentials
	}
	if !utf8.ValidString(username) || len(username) > 64 {
		if _, err := s.passwords.hash(ctx, "unknown-account-dummy-password"); err != nil {
			return Session{}, err
		}
		return Session{}, ErrInvalidCredentials
	}
	user, err := sqlc.New(s.reader).AuthGetUserByUsername(ctx, username)
	if errors.Is(err, sql.ErrNoRows) {
		if _, dummyErr := s.passwords.hash(ctx, "unknown-account-dummy-password"); dummyErr != nil {
			return Session{}, dummyErr
		}
		return Session{}, ErrInvalidCredentials
	}
	if err != nil {
		return Session{}, fmt.Errorf("look up login user: %w", err)
	}
	valid, err := s.passwords.verify(ctx, password, user.PasswordHash)
	if err != nil {
		return Session{}, fmt.Errorf("verify password hash: %w", err)
	}
	if !valid || user.Disabled != 0 {
		return Session{}, ErrInvalidCredentials
	}
	var replacementHash string
	if s.passwords.needsRehash(user.PasswordHash) {
		replacementHash, err = s.passwords.hash(ctx, password)
		if err != nil {
			return Session{}, err
		}
	}

	var random [32]byte
	if _, err := rand.Read(random[:]); err != nil {
		return Session{}, fmt.Errorf("generate session token: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(random[:])
	now := s.now()
	expires := now.Add(sessionLifetime)
	err = db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		current, err := queries.AuthGetUserByID(ctx, user.ID)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && (current.Disabled != 0 || current.PasswordHash != user.PasswordHash)) {
			return ErrInvalidCredentials
		}
		if err != nil {
			return fmt.Errorf("recheck login user: %w", err)
		}
		user = current
		if replacementHash != "" {
			if err := queries.AuthUpdatePassword(ctx, sqlc.AuthUpdatePasswordParams{
				PasswordHash: replacementHash, UpdatedAt: now.UnixMilli(), ID: user.ID,
			}); err != nil {
				return fmt.Errorf("rehash login password: %w", err)
			}
		}
		if err := queries.AuthCreateSession(ctx, sqlc.AuthCreateSessionParams{
			TokenHash: hashToken(token), UserID: user.ID, CreatedAt: now.UnixMilli(),
			ExpiresAt: expires.UnixMilli(), LastSeenAt: now.UnixMilli(),
			UserAgent: truncateUTF8(userAgent, 256), Ip: truncateUTF8(ip, 64),
		}); err != nil {
			return fmt.Errorf("create browser session: %w", err)
		}
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	return Session{User: safeUser(user), Token: token, ExpiresAt: expires}, nil
}

// Authenticate resolves a raw cookie token to its current, enabled user.
func (s *Service) Authenticate(ctx context.Context, token string) (User, error) {
	if !validSessionToken(token) {
		return User{}, ErrInvalidSession
	}
	row, err := sqlc.New(s.reader).AuthGetSession(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrInvalidSession
	}
	if err != nil {
		return User{}, fmt.Errorf("look up browser session: %w", err)
	}
	now := s.now()
	if row.Disabled != 0 || now.UnixMilli() >= row.ExpiresAt {
		if row.Disabled == 0 {
			if err := sqlc.New(s.writer).AuthDeleteSession(ctx, hashToken(token)); err != nil {
				return User{}, fmt.Errorf("delete expired session: %w", err)
			}
		}
		return User{}, ErrInvalidSession
	}
	if now.UnixMilli()-row.LastSeenAt >= sessionTouchAge.Milliseconds() {
		if err := sqlc.New(s.writer).AuthTouchSession(ctx, sqlc.AuthTouchSessionParams{
			LastSeenAt: now.UnixMilli(), ExpiresAt: now.Add(sessionLifetime).UnixMilli(),
			TokenHash: hashToken(token), LastSeenAt_2: now.Add(-sessionTouchAge).UnixMilli(),
		}); err != nil {
			return User{}, fmt.Errorf("slide browser session: %w", err)
		}
	}
	return User{
		ID: row.ID, Username: row.Username, DisplayName: row.DisplayName, Role: row.Role, Locale: row.Locale,
	}, nil
}

// Logout deletes the session represented by token. Empty or malformed tokens are harmless.
func (s *Service) Logout(ctx context.Context, token string) error {
	if token == "" {
		return nil
	}
	if !validSessionToken(token) {
		return nil
	}
	if err := sqlc.New(s.writer).AuthDeleteSession(ctx, hashToken(token)); err != nil {
		return fmt.Errorf("delete browser session: %w", err)
	}
	return nil
}

// UpdateProfile updates only the current user's display name and locale.
func (s *Service) UpdateProfile(ctx context.Context, userID int64, displayName, locale string) error {
	displayName = strings.TrimSpace(displayName)
	if !utf8.ValidString(displayName) || len(displayName) > 128 {
		return fmt.Errorf("%w: display name must be valid UTF-8 and at most 128 bytes", ErrInvalidUser)
	}
	if locale != "en" && locale != "zh" {
		return fmt.Errorf("%w: locale must be en or zh", ErrInvalidUser)
	}
	if err := sqlc.New(s.writer).AuthUpdateProfile(ctx, sqlc.AuthUpdateProfileParams{
		DisplayName: displayName, Locale: locale, UpdatedAt: s.now().UnixMilli(), ID: userID,
	}); err != nil {
		return fmt.Errorf("update profile: %w", err)
	}
	return nil
}

// CreateAppPassword generates and stores an app password, returning its secret only once.
func (s *Service) CreateAppPassword(ctx context.Context, userID int64, kind, label string) (AppPassword, error) {
	label = strings.TrimSpace(label)
	if kind != "opds" && kind != "kosync" {
		return AppPassword{}, fmt.Errorf("%w: kind must be opds or kosync", ErrInvalidUser)
	}
	if label == "" || !utf8.ValidString(label) || len(label) > 64 {
		return AppPassword{}, fmt.Errorf("%w: label must be 1 to 64 bytes", ErrInvalidUser)
	}
	secret, err := generateAppPassword()
	if err != nil {
		return AppPassword{}, fmt.Errorf("generate app password: %w", err)
	}
	created, err := sqlc.New(s.writer).AuthCreateAppPassword(ctx, sqlc.AuthCreateAppPasswordParams{
		UserID: userID, Kind: kind, Label: label, SecretHash: appPasswordHash(kind, secret),
		CreatedAt: s.now().UnixMilli(),
	})
	if err != nil {
		return AppPassword{}, fmt.Errorf("create app password: %w", err)
	}
	return AppPassword{
		ID: created.ID, Kind: created.Kind, Label: created.Label,
		CreatedAt: time.UnixMilli(created.CreatedAt).UTC(), Secret: formatAppPassword(secret),
	}, nil
}

// ListAppPasswords returns credentials owned by the given user without secret hashes.
func (s *Service) ListAppPasswords(ctx context.Context, userID int64) ([]AppPassword, error) {
	rows, err := sqlc.New(s.reader).AuthListAppPasswords(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list app passwords: %w", err)
	}
	result := make([]AppPassword, 0, len(rows))
	for _, row := range rows {
		item := AppPassword{ID: row.ID, Kind: row.Kind, Label: row.Label, CreatedAt: time.UnixMilli(row.CreatedAt).UTC()}
		if row.LastUsedAt.Valid {
			lastUsed := time.UnixMilli(row.LastUsedAt.Int64).UTC()
			item.LastUsedAt = &lastUsed
		}
		result = append(result, item)
	}
	return result, nil
}

// RevokeAppPassword deletes only a credential owned by the given user.
func (s *Service) RevokeAppPassword(ctx context.Context, userID, id int64) error {
	if id <= 0 {
		return ErrAppPasswordMissing
	}
	if _, err := sqlc.New(s.reader).AuthGetAppPasswordByID(ctx, sqlc.AuthGetAppPasswordByIDParams{
		ID: id, UserID: userID,
	}); errors.Is(err, sql.ErrNoRows) {
		return ErrAppPasswordMissing
	} else if err != nil {
		return fmt.Errorf("find app password to revoke: %w", err)
	}
	if err := sqlc.New(s.writer).AuthDeleteAppPassword(ctx, sqlc.AuthDeleteAppPasswordParams{
		ID: id, UserID: userID,
	}); err != nil {
		return fmt.Errorf("revoke app password: %w", err)
	}
	return nil
}

// VerifyAppPassword verifies OPDS plaintext or a KOReader-supplied MD5 hex value.
func (s *Service) VerifyAppPassword(ctx context.Context, username, kind, supplied string) (User, error) {
	var hash []byte
	switch kind {
	case "opds":
		secret := strings.ReplaceAll(supplied, "-", "")
		if len(secret) != 16 {
			return User{}, ErrInvalidCredentials
		}
		hash = appPasswordHash(kind, secret)
	case "kosync":
		if len(supplied) != md5.Size*2 {
			return User{}, ErrInvalidCredentials
		}
		digest, err := hex.DecodeString(supplied)
		if err != nil {
			return User{}, ErrInvalidCredentials
		}
		lowerHex := []byte(hex.EncodeToString(digest))
		sum := sha256.Sum256(lowerHex)
		hash = sum[:]
	default:
		return User{}, ErrInvalidCredentials
	}
	row, err := sqlc.New(s.reader).AuthGetAppPasswordByHash(ctx, sqlc.AuthGetAppPasswordByHashParams{
		SecretHash: hash, Kind: kind,
	})
	if errors.Is(err, sql.ErrNoRows) || (err == nil && (!strings.EqualFold(row.Username, username) || row.Disabled != 0)) {
		return User{}, ErrInvalidCredentials
	}
	if err != nil {
		return User{}, fmt.Errorf("look up app password: %w", err)
	}
	if err := sqlc.New(s.writer).AuthTouchAppPassword(ctx, sqlc.AuthTouchAppPasswordParams{
		LastUsedAt: sql.NullInt64{Int64: s.now().UnixMilli(), Valid: true}, ID: row.ID,
	}); err != nil {
		return User{}, fmt.Errorf("update app password last-used time: %w", err)
	}
	return User{ID: row.UserID, Username: row.Username, Role: row.Role}, nil
}

func normalizeUserInput(input CreateUserInput) (CreateUserInput, error) {
	input, err := normalizeAccountFields(input)
	if err != nil {
		return CreateUserInput{}, err
	}
	if err := validatePassword(input.Password); err != nil {
		return CreateUserInput{}, fmt.Errorf("%w: %v", ErrInvalidUser, err)
	}
	return input, nil
}

func normalizeAccountFields(input CreateUserInput) (CreateUserInput, error) {
	input.Username = strings.TrimSpace(input.Username)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	if input.Username == "" || len(input.Username) > 64 || !utf8.ValidString(input.Username) || strings.ContainsRune(input.Username, 0) {
		return CreateUserInput{}, fmt.Errorf("%w: username must be 1 to 64 UTF-8 bytes", ErrInvalidUser)
	}
	if !utf8.ValidString(input.DisplayName) || len(input.DisplayName) > 128 {
		return CreateUserInput{}, fmt.Errorf("%w: display name must be at most 128 UTF-8 bytes", ErrInvalidUser)
	}
	if input.Role == "" {
		input.Role = "user"
	}
	if input.Role != "admin" && input.Role != "user" {
		return CreateUserInput{}, fmt.Errorf("%w: role must be admin or user", ErrInvalidUser)
	}
	if input.Locale == "" {
		input.Locale = "en"
	}
	if input.Locale != "en" && input.Locale != "zh" {
		return CreateUserInput{}, fmt.Errorf("%w: locale must be en or zh", ErrInvalidUser)
	}
	return input, nil
}

func safeUser(user sqlc.User) User {
	return User{
		ID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
		Role: user.Role, Locale: user.Locale, Disabled: user.Disabled != 0,
	}
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func validSessionToken(token string) bool {
	if len(token) > 64 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(decoded) == 32
}

func truncateUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func generateAppPassword() (string, error) {
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return "", err
	}
	var secret [16]byte
	for index, value := range random {
		secret[index] = alphabet[value&31]
	}
	return string(secret[:]), nil
}

func appPasswordHash(kind, secret string) []byte {
	if kind == "kosync" {
		digest := md5.Sum([]byte(secret))
		secret = hex.EncodeToString(digest[:])
	}
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}

func formatAppPassword(secret string) string {
	return secret[:4] + "-" + secret[4:8] + "-" + secret[8:12] + "-" + secret[12:16]
}
