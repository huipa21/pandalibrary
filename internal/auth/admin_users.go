package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

var (
	ErrAdminRequired    = errors.New("administrator access is required")
	ErrProtectedAccount = errors.New("cannot delete, disable or demote yourself or the last enabled administrator")
)

// AdminUser is the complete, secret-free account-management DTO.
type AdminUser struct {
	ID          int64     `json:"id"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	Locale      string    `json:"locale"`
	Disabled    bool      `json:"disabled"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// AdminUserPatch preserves omitted fields. Null fields are rejected by the HTTP decoder.
type AdminUserPatch struct {
	Username    *string `json:"username"`
	DisplayName *string `json:"display_name"`
	Role        *string `json:"role"`
	Locale      *string `json:"locale"`
	Disabled    *bool   `json:"disabled"`
}

func adminUser(user sqlc.User) AdminUser {
	return AdminUser{
		ID: user.ID, Username: user.Username, DisplayName: user.DisplayName,
		Role: user.Role, Locale: user.Locale, Disabled: user.Disabled != 0,
		CreatedAt: time.UnixMilli(user.CreatedAt).UTC(), UpdatedAt: time.UnixMilli(user.UpdatedAt).UTC(),
	}
}

func (s *Service) checkAdmin(ctx context.Context, queries *sqlc.Queries, token string) (int64, error) {
	if !validSessionToken(token) {
		return 0, ErrInvalidSession
	}
	row, err := queries.AuthGetSession(ctx, hashToken(token))
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrInvalidSession
	}
	if err != nil {
		return 0, fmt.Errorf("check administrator session: %w", err)
	}
	if row.Disabled != 0 || row.ExpiresAt <= s.now().UnixMilli() {
		return 0, ErrInvalidSession
	}
	if row.Role != "admin" {
		return 0, ErrAdminRequired
	}
	return row.ID, nil
}

func (s *Service) withAdmin(ctx context.Context, token string, fn func(*sqlc.Queries, int64) error) error {
	return db.WithTx(ctx, s.writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		actor, err := s.checkAdmin(ctx, queries, token)
		if err != nil {
			return err
		}
		return fn(queries, actor)
	})
}

func findAdminUser(ctx context.Context, queries *sqlc.Queries, id int64) (sqlc.User, error) {
	if id < 1 {
		return sqlc.User{}, fmt.Errorf("%w: user ID must be positive", ErrInvalidUser)
	}
	user, err := queries.AuthGetUserByID(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return sqlc.User{}, ErrUserNotFound
	}
	if err != nil {
		return sqlc.User{}, fmt.Errorf("find managed user: %w", err)
	}
	return user, nil
}

// AdminGetUser reads one account after checking a live administrator session.
func (s *Service) AdminGetUser(ctx context.Context, token string, id int64) (AdminUser, error) {
	queries := sqlc.New(s.reader)
	if _, err := s.checkAdmin(ctx, queries, token); err != nil {
		return AdminUser{}, err
	}
	user, err := findAdminUser(ctx, queries, id)
	return adminUser(user), err
}

// AdminCreateUser creates an enabled account with the same policies as the CLI.
func (s *Service) AdminCreateUser(ctx context.Context, token string, input CreateUserInput) (AdminUser, error) {
	if _, err := s.checkAdmin(ctx, sqlc.New(s.reader), token); err != nil {
		return AdminUser{}, err
	}
	input, err := normalizeUserInput(input)
	if err != nil {
		return AdminUser{}, err
	}
	hash, err := s.passwords.hash(ctx, input.Password)
	if err != nil {
		return AdminUser{}, err
	}
	var user sqlc.User
	err = s.withAdmin(ctx, token, func(queries *sqlc.Queries, _ int64) error {
		var err error
		user, err = s.createUser(ctx, queries, input, hash)
		return err
	})
	return adminUser(user), err
}

func (s *Service) protectAdmin(ctx context.Context, queries *sqlc.Queries, actor int64, user sqlc.User) error {
	if actor == user.ID {
		return ErrProtectedAccount
	}
	if user.Role == "admin" && user.Disabled == 0 {
		count, err := queries.AdminCountEnabled(ctx)
		if err != nil {
			return fmt.Errorf("count enabled administrators: %w", err)
		}
		if count <= 1 {
			return ErrProtectedAccount
		}
	}
	return nil
}

// AdminUpdateUser atomically applies fields, lockout guards and credential revocation.
func (s *Service) AdminUpdateUser(ctx context.Context, token string, id int64, patch AdminUserPatch) (AdminUser, error) {
	var updated sqlc.User
	err := s.withAdmin(ctx, token, func(queries *sqlc.Queries, actor int64) error {
		user, err := findAdminUser(ctx, queries, id)
		if err != nil {
			return err
		}
		input := CreateUserInput{Username: user.Username, DisplayName: user.DisplayName, Role: user.Role, Locale: user.Locale}
		if patch.Username != nil {
			input.Username = *patch.Username
		}
		if patch.DisplayName != nil {
			input.DisplayName = *patch.DisplayName
		}
		if patch.Role != nil {
			if *patch.Role == "" {
				return fmt.Errorf("%w: role must be admin or user", ErrInvalidUser)
			}
			input.Role = *patch.Role
		}
		if patch.Locale != nil {
			if *patch.Locale == "" {
				return fmt.Errorf("%w: locale must be en or zh", ErrInvalidUser)
			}
			input.Locale = *patch.Locale
		}
		input, err = normalizeAccountFields(input)
		if err != nil {
			return err
		}
		disabled := user.Disabled
		if patch.Disabled != nil {
			disabled = 0
			if *patch.Disabled {
				disabled = 1
			}
		}
		if disabled != 0 || (user.Role == "admin" && input.Role != "admin") {
			if err := s.protectAdmin(ctx, queries, actor, user); err != nil {
				return err
			}
		}
		updated, err = queries.AdminUpdateUser(ctx, sqlc.AdminUpdateUserParams{
			Username: input.Username, DisplayName: input.DisplayName, Role: input.Role,
			Locale: input.Locale, Disabled: disabled, UpdatedAt: s.now().UnixMilli(), ID: id,
		})
		if err != nil {
			return userWriteError(err)
		}
		if disabled != 0 {
			return revokeCredentials(ctx, queries, id)
		}
		if user.Role != updated.Role {
			if err := queries.AuthRevokeUserSessions(ctx, id); err != nil {
				return fmt.Errorf("revoke sessions after role change: %w", err)
			}
		}
		return nil
	})
	return adminUser(updated), err
}

// AdminDeleteUser relies on the existing FK cascade/set-null policies.
func (s *Service) AdminDeleteUser(ctx context.Context, token string, id int64) error {
	return s.withAdmin(ctx, token, func(queries *sqlc.Queries, actor int64) error {
		user, err := findAdminUser(ctx, queries, id)
		if err != nil {
			return err
		}
		if err := s.protectAdmin(ctx, queries, actor, user); err != nil {
			return err
		}
		if err := queries.AdminDeleteUser(ctx, id); err != nil {
			return fmt.Errorf("delete managed user: %w", err)
		}
		return nil
	})
}

// AdminResetPassword revokes every credential, including the actor's on a self reset.
func (s *Service) AdminResetPassword(ctx context.Context, token string, id int64, password string) error {
	if _, err := s.checkAdmin(ctx, sqlc.New(s.reader), token); err != nil {
		return err
	}
	if err := validatePassword(password); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidUser, err)
	}
	hash, err := s.passwords.hash(ctx, password)
	if err != nil {
		return err
	}
	return s.withAdmin(ctx, token, func(queries *sqlc.Queries, _ int64) error {
		if _, err := findAdminUser(ctx, queries, id); err != nil {
			return err
		}
		return s.resetPassword(ctx, queries, id, hash)
	})
}

// AdminRevokeCredentials invalidates all browser and device credentials.
func (s *Service) AdminRevokeCredentials(ctx context.Context, token string, id int64) error {
	return s.withAdmin(ctx, token, func(queries *sqlc.Queries, _ int64) error {
		if _, err := findAdminUser(ctx, queries, id); err != nil {
			return err
		}
		return revokeCredentials(ctx, queries, id)
	})
}

func revokeCredentials(ctx context.Context, queries *sqlc.Queries, id int64) error {
	if err := queries.AuthRevokeUserSessions(ctx, id); err != nil {
		return fmt.Errorf("revoke browser sessions: %w", err)
	}
	if err := queries.AdminRevokeAppPasswords(ctx, id); err != nil {
		return fmt.Errorf("revoke app passwords: %w", err)
	}
	return nil
}

func (s *Service) resetPassword(ctx context.Context, queries *sqlc.Queries, id int64, hash string) error {
	if err := queries.AuthUpdatePassword(ctx, sqlc.AuthUpdatePasswordParams{
		PasswordHash: hash, UpdatedAt: s.now().UnixMilli(), ID: id,
	}); err != nil {
		return fmt.Errorf("update password: %w", err)
	}
	return revokeCredentials(ctx, queries, id)
}

func (s *Service) createUser(ctx context.Context, queries *sqlc.Queries, input CreateUserInput, hash string) (sqlc.User, error) {
	count, err := queries.AuthCountUsers(ctx)
	if err != nil {
		return sqlc.User{}, fmt.Errorf("check initial user role: %w", err)
	}
	if count == 0 && input.Role != "admin" {
		return sqlc.User{}, ErrFirstUserMustAdmin
	}
	user, err := queries.AuthCreateUser(ctx, sqlc.AuthCreateUserParams{
		Username: input.Username, DisplayName: input.DisplayName, PasswordHash: hash,
		Role: input.Role, Locale: input.Locale, CreatedAt: s.now().UnixMilli(), UpdatedAt: s.now().UnixMilli(),
	})
	if err != nil {
		return sqlc.User{}, userWriteError(err)
	}
	return user, nil
}

func userWriteError(err error) error {
	var coded interface{ Code() int }
	if errors.As(err, &coded) && coded.Code() == 2067 { // SQLITE_CONSTRAINT_UNIQUE (username).
		return ErrUsernameTaken
	}
	// Database errors can include bound values; do not propagate them to HTTP logs.
	if coded != nil {
		return fmt.Errorf("write account failed (SQLite code %d)", coded.Code())
	}
	return errors.New("write account failed")
}
