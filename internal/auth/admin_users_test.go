package auth

import (
	"crypto/md5"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/sqlc"
)

func adminTestService(t *testing.T) (*Service, *db.DB, Session) {
	t.Helper()
	databases := testDatabases(t)
	service, err := NewService(t.Context(), databases.Writer, databases.Reader, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateUser(t.Context(), CreateUserInput{
		Username: "admin", Role: "admin", Password: "correct horse battery",
	}); err != nil {
		t.Fatal(err)
	}
	session, err := service.Login(t.Context(), "admin", "correct horse battery", "", "")
	if err != nil {
		t.Fatal(err)
	}
	return service, databases, session
}

func adminCreate(t *testing.T, service *Service, actor Session, username, role string) AdminUser {
	t.Helper()
	user, err := service.AdminCreateUser(t.Context(), actor.Token, CreateUserInput{
		Username: username, Password: "correct horse battery", Role: role,
	})
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func pointer[T any](value T) *T { return &value }

func TestAdminUsersCRUDAndPagination(t *testing.T) {
	service, _, actor := adminTestService(t)
	ctx := t.Context()
	beta := adminCreate(t, service, actor, "Beta", "user")
	alpha := adminCreate(t, service, actor, "alpha", "user")
	if beta.Disabled || beta.Locale != "en" || beta.CreatedAt.IsZero() || beta.UpdatedAt.IsZero() {
		t.Fatalf("defaults: %+v", beta)
	}
	_, err := service.AdminCreateUser(ctx, actor.Token, CreateUserInput{
		Username: "BETA", Password: "correct horse battery",
	})
	if !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("duplicate creation: %v", err)
	}
	var names []string
	cursor := ""
	for {
		page, err := service.AdminListUsers(ctx, actor.Token, 1, cursor)
		if err != nil || len(page.Items) != 1 {
			t.Fatalf("page: %+v, %v", page, err)
		}
		raw, err := json.Marshal(page.Items[0])
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatal(err)
		}
		if len(fields) != 8 {
			t.Fatalf("unsafe DTO: %s", raw)
		}
		names = append(names, page.Items[0].Username)
		if page.NextCursor == nil {
			break
		}
		cursor = *page.NextCursor
	}
	if strings.Join(names, ",") != "admin,alpha,Beta" {
		t.Fatalf("page order: %v", names)
	}
	for _, cursor := range []string{"not-a-cursor", strings.Repeat("x", 1025), "e30"} {
		if _, err := service.AdminListUsers(ctx, actor.Token, 1, cursor); !errors.Is(err, ErrInvalidUser) {
			t.Fatalf("cursor accepted: %v", err)
		}
	}
	if _, err := service.AdminListUsers(ctx, actor.Token, 101, ""); !errors.Is(err, ErrInvalidUser) {
		t.Fatalf("limit accepted: %v", err)
	}
	updated, err := service.AdminUpdateUser(ctx, actor.Token, beta.ID, AdminUserPatch{
		Username: pointer("Renamed"), DisplayName: pointer(" Reader "), Locale: pointer("zh"),
	})
	if err != nil || updated.Username != "Renamed" || updated.DisplayName != "Reader" ||
		updated.Locale != "zh" || updated.Role != beta.Role || !updated.CreatedAt.Equal(beta.CreatedAt) {
		t.Fatalf("patch: %+v, %v", updated, err)
	}
	if _, err := service.AdminUpdateUser(ctx, actor.Token, beta.ID, AdminUserPatch{
		Username: pointer(alpha.Username),
	}); !errors.Is(err, ErrUsernameTaken) {
		t.Fatalf("duplicate patch: %v", err)
	}
	for _, patch := range []AdminUserPatch{
		{Username: pointer("")}, {Username: pointer(strings.Repeat("x", 65))},
		{DisplayName: pointer(strings.Repeat("x", 129))}, {Role: pointer("")},
		{Role: pointer("owner")}, {Locale: pointer("")}, {Locale: pointer("fr")},
	} {
		if _, err := service.AdminUpdateUser(ctx, actor.Token, beta.ID, patch); !errors.Is(err, ErrInvalidUser) {
			t.Fatalf("invalid patch accepted: %+v, %v", patch, err)
		}
	}
	if err := service.AdminDeleteUser(ctx, actor.Token, beta.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdminGetUser(ctx, actor.Token, beta.ID); !errors.Is(err, ErrUserNotFound) {
		t.Fatalf("deleted account: %v", err)
	}
	if _, err := service.AdminGetUser(ctx, actor.Token, 0); !errors.Is(err, ErrInvalidUser) {
		t.Fatalf("invalid ID: %v", err)
	}
}

func TestAdminCredentialInvalidation(t *testing.T) {
	for _, operation := range []string{"reset", "disable", "revoke", "cli-reset", "role"} {
		t.Run(operation, func(t *testing.T) {
			service, _, actor := adminTestService(t)
			ctx := t.Context()
			target := adminCreate(t, service, actor, "reader", "user")
			session, err := service.Login(ctx, "reader", "correct horse battery", "", "")
			if err != nil {
				t.Fatal(err)
			}
			opds, err := service.CreateAppPassword(ctx, target.ID, "opds", "OPDS")
			if err != nil {
				t.Fatal(err)
			}
			kosync, err := service.CreateAppPassword(ctx, target.ID, "kosync", "KOReader")
			if err != nil {
				t.Fatal(err)
			}
			switch operation {
			case "reset":
				err = service.AdminResetPassword(ctx, actor.Token, target.ID, "replacement password")
			case "disable":
				_, err = service.AdminUpdateUser(ctx, actor.Token, target.ID, AdminUserPatch{Disabled: pointer(true)})
			case "revoke":
				err = service.AdminRevokeCredentials(ctx, actor.Token, target.ID)
			case "cli-reset":
				err = service.ResetPassword(ctx, target.Username, "replacement password")
			case "role":
				_, err = service.AdminUpdateUser(ctx, actor.Token, target.ID, AdminUserPatch{Role: pointer("admin")})
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.Authenticate(ctx, session.Token); !errors.Is(err, ErrInvalidSession) {
				t.Fatalf("session survived %s: %v", operation, err)
			}
			if operation == "disable" {
				if _, err := service.Login(ctx, "reader", "correct horse battery", "", ""); !errors.Is(err, ErrInvalidCredentials) {
					t.Fatalf("disabled login: %v", err)
				}
				if _, err := service.AdminUpdateUser(ctx, actor.Token, target.ID, AdminUserPatch{Disabled: pointer(false)}); err != nil {
					t.Fatal(err)
				}
			}
			opdsUser, opdsErr := service.VerifyAppPassword(ctx, "reader", "opds", opds.Secret)
			digest := fmt.Sprintf("%x", md5.Sum([]byte(strings.ReplaceAll(kosync.Secret, "-", ""))))
			_, kosyncErr := service.VerifyAppPassword(ctx, "reader", "kosync", digest)
			if operation == "role" {
				if opdsErr != nil || kosyncErr != nil || opdsUser.Role != "admin" {
					t.Fatalf("role-change app auth: %+v, %v, %v", opdsUser, opdsErr, kosyncErr)
				}
			} else if !errors.Is(opdsErr, ErrInvalidCredentials) || !errors.Is(kosyncErr, ErrInvalidCredentials) {
				t.Fatalf("app credentials survived %s: %v, %v", operation, opdsErr, kosyncErr)
			}
			if operation == "reset" || operation == "cli-reset" {
				if _, err := service.Login(ctx, "reader", "correct horse battery", "", ""); !errors.Is(err, ErrInvalidCredentials) {
					t.Fatalf("old password survived reset: %v", err)
				}
				if _, err := service.Login(ctx, "reader", "replacement password", "", ""); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestAdminSelfAndLastAdminGuards(t *testing.T) {
	service, databases, actor := adminTestService(t)
	ctx := t.Context()
	for _, patch := range []AdminUserPatch{{Disabled: pointer(true)}, {Role: pointer("user")}} {
		if _, err := service.AdminUpdateUser(ctx, actor.Token, actor.User.ID, patch); !errors.Is(err, ErrProtectedAccount) {
			t.Fatalf("self mutation: %v", err)
		}
	}
	if err := service.AdminDeleteUser(ctx, actor.Token, actor.User.ID); !errors.Is(err, ErrProtectedAccount) {
		t.Fatalf("self deletion: %v", err)
	}
	// Exercise the enabled-admin count independently of the self guard.
	err := db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		user, err := queries.AuthGetUserByID(ctx, actor.User.ID)
		if err != nil {
			return err
		}
		return service.protectAdmin(ctx, queries, 999, user)
	})
	if !errors.Is(err, ErrProtectedAccount) {
		t.Fatalf("last enabled administrator: %v", err)
	}
	adminCreate(t, service, actor, "disabled-admin", "admin")
	if _, err := databases.Writer.ExecContext(ctx, "UPDATE users SET disabled = 1 WHERE username = 'disabled-admin'"); err != nil {
		t.Fatal(err)
	}
	err = db.WithTx(ctx, databases.Writer, func(tx *sql.Tx) error {
		queries := sqlc.New(tx)
		user, err := queries.AuthGetUserByID(ctx, actor.User.ID)
		if err != nil {
			return err
		}
		return service.protectAdmin(ctx, queries, 999, user)
	})
	if !errors.Is(err, ErrProtectedAccount) {
		t.Fatalf("disabled admin counted as enabled: %v", err)
	}
	if err := service.AdminResetPassword(ctx, actor.Token, actor.User.ID, "short"); !errors.Is(err, ErrInvalidUser) {
		t.Fatalf("password policy: %v", err)
	}
	if err := service.AdminResetPassword(ctx, actor.Token, actor.User.ID, "replacement password"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdminGetUser(ctx, actor.Token, actor.User.ID); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("self reset did not revoke actor: %v", err)
	}
}

func TestAdminConcurrentMutationsRecheckActor(t *testing.T) {
	for _, operation := range []string{"disable", "demote", "delete", "revoke"} {
		t.Run(operation, func(t *testing.T) {
			service, databases, first := adminTestService(t)
			second := adminCreate(t, service, first, "second", "admin")
			session, err := service.Login(t.Context(), second.Username, "correct horse battery", "", "")
			if err != nil {
				t.Fatal(err)
			}
			start := make(chan struct{})
			results := make(chan error, 2)
			var wg sync.WaitGroup
			for _, pair := range []struct {
				actor  Session
				target int64
			}{{first, second.ID}, {session, first.User.ID}} {
				wg.Go(func() {
					<-start
					var err error
					switch operation {
					case "disable":
						_, err = service.AdminUpdateUser(t.Context(), pair.actor.Token, pair.target, AdminUserPatch{Disabled: pointer(true)})
					case "demote":
						_, err = service.AdminUpdateUser(t.Context(), pair.actor.Token, pair.target, AdminUserPatch{Role: pointer("user")})
					case "delete":
						err = service.AdminDeleteUser(t.Context(), pair.actor.Token, pair.target)
					case "revoke":
						err = service.AdminRevokeCredentials(t.Context(), pair.actor.Token, pair.target)
					}
					results <- err
				})
			}
			close(start)
			wg.Wait()
			close(results)
			success := 0
			for err := range results {
				if err == nil {
					success++
				} else if !errors.Is(err, ErrInvalidSession) {
					t.Fatalf("unexpected concurrent result: %v", err)
				}
			}
			if success != 1 {
				t.Fatalf("successful mutations = %d, want 1", success)
			}
			count, err := sqlc.New(databases.Reader).AdminCountEnabled(t.Context())
			if err != nil || count < 1 {
				t.Fatalf("enabled administrators = %d, %v", count, err)
			}
		})
	}
}

func TestAdminRevocationRollback(t *testing.T) {
	service, databases, actor := adminTestService(t)
	ctx := t.Context()
	target := adminCreate(t, service, actor, "reader", "user")
	session, err := service.Login(ctx, "reader", "correct horse battery", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateAppPassword(ctx, target.ID, "opds", "Device"); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(ctx, `CREATE TRIGGER reject_revoke BEFORE DELETE ON app_passwords
		BEGIN SELECT RAISE(ABORT, 'test revocation failure'); END`); err != nil {
		t.Fatal(err)
	}
	original, err := sqlc.New(databases.Reader).AuthGetUserByID(ctx, target.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func() error{
		func() error { return service.AdminResetPassword(ctx, actor.Token, target.ID, "replacement password") },
		func() error {
			_, err := service.AdminUpdateUser(ctx, actor.Token, target.ID, AdminUserPatch{Disabled: pointer(true)})
			return err
		},
		func() error { return service.AdminRevokeCredentials(ctx, actor.Token, target.ID) },
		func() error { return service.AdminDeleteUser(ctx, actor.Token, target.ID) },
	} {
		if err := operation(); err == nil {
			t.Fatal("mutation ignored revocation failure")
		}
		current, err := sqlc.New(databases.Reader).AuthGetUserByID(ctx, target.ID)
		if err != nil || current.PasswordHash != original.PasswordHash || current.Disabled != 0 ||
			current.UpdatedAt != original.UpdatedAt {
			t.Fatalf("account mutation was not rolled back: %v", err)
		}
		if _, err := service.Authenticate(ctx, session.Token); err != nil {
			t.Fatalf("session deletion was not rolled back: %v", err)
		}
		passwords, err := service.ListAppPasswords(ctx, target.ID)
		if err != nil || len(passwords) != 1 {
			t.Fatalf("app-password deletion was not rolled back: %v", err)
		}
	}
}

func TestAdminRejectsRevokedAndNonAdminActors(t *testing.T) {
	service, _, actor := adminTestService(t)
	target := adminCreate(t, service, actor, "reader", "user")
	reader, err := service.Login(t.Context(), target.Username, "correct horse battery", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		token string
		want  error
	}{{reader.Token, ErrAdminRequired}, {"invalid", ErrInvalidSession}} {
		if err := service.AdminDeleteUser(t.Context(), test.token, target.ID); !errors.Is(err, test.want) {
			t.Fatalf("actor check: %v", err)
		}
	}
	if err := service.AdminRevokeCredentials(t.Context(), actor.Token, actor.User.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdminUpdateUser(t.Context(), actor.Token, target.ID, AdminUserPatch{}); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("revoked actor mutation: %v", err)
	}
}

func TestAdminDeletePreservesSharedCatalog(t *testing.T) {
	service, databases, actor := adminTestService(t)
	ctx := t.Context()
	target := adminCreate(t, service, actor, "reader", "user")
	for _, statement := range []string{
		`INSERT INTO libraries (id,name,slug,created_at,updated_at) VALUES (1,'Library','library',1,1)`,
		fmt.Sprintf(`INSERT INTO books (id,library_id,title,sort_title,added_by,created_at,updated_at) VALUES (1,1,'Book','book',%d,1,1)`, target.ID),
		fmt.Sprintf(`INSERT INTO library_access (library_id,user_id,granted_at) VALUES (1,%d,1)`, target.ID),
		fmt.Sprintf(`INSERT INTO shelves (id,kind,owner_id,name,created_by,created_at,updated_at) VALUES (1,'private',%d,'Private',%d,1,1)`, target.ID, target.ID),
		fmt.Sprintf(`INSERT INTO shelves (id,kind,name,created_by,created_at,updated_at) VALUES (2,'shared','Shared',%d,1,1)`, target.ID),
		fmt.Sprintf(`INSERT INTO shelf_books (shelf_id,book_id,added_by,added_at) VALUES (2,1,%d,1)`, target.ID),
		fmt.Sprintf(`INSERT INTO user_settings (user_id,key,value,updated_at,rev) VALUES (%d,'test','{}',1,1)`, target.ID),
	} {
		if _, err := databases.Writer.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}

	}
	session, err := service.Login(ctx, target.Username, "correct horse battery", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateAppPassword(ctx, target.ID, "opds", "Device"); err != nil {
		t.Fatal(err)
	}
	if err := service.AdminDeleteUser(ctx, actor.Token, target.ID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"sessions", "app_passwords", "library_access", "user_settings"} {
		var count int
		if err := databases.Reader.QueryRowContext(ctx, "SELECT count(*) FROM "+table+" WHERE user_id = ?", target.ID).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s private data survived: %d, %v", table, count, err)
		}
	}
	for _, query := range []string{
		"SELECT count(*) FROM libraries",
		"SELECT count(*) FROM books WHERE added_by IS NULL",
		"SELECT count(*) FROM shelves WHERE id = 2 AND created_by IS NULL",
		"SELECT count(*) FROM shelf_books WHERE added_by IS NULL",
	} {
		var count int
		if err := databases.Reader.QueryRowContext(ctx, query).Scan(&count); err != nil || count != 1 {
			t.Fatalf("shared data changed: %s: %d, %v", query, count, err)
		}
	}
	var count int
	if err := databases.Reader.QueryRowContext(ctx, "SELECT count(*) FROM shelves WHERE id = 1").Scan(&count); err != nil || count != 0 {
		t.Fatalf("private shelf survived: %d, %v", count, err)
	}
	if _, err := service.Authenticate(ctx, session.Token); !errors.Is(err, ErrInvalidSession) {
		t.Fatalf("deleted user session: %v", err)
	}
}

func TestLoginRechecksAccountAfterPasswordVerification(t *testing.T) {
	for _, operation := range []string{"reset", "disable", "delete", "role"} {
		t.Run(operation, func(t *testing.T) {
			service, _, actor := adminTestService(t)
			target := adminCreate(t, service, actor, "reader", "user")
			now := service.now
			// Login samples the clock after Argon2 verification, before acquiring the writer.
			service.now = func() time.Time {
				service.now = now
				var err error
				switch operation {
				case "reset":
					err = service.AdminResetPassword(t.Context(), actor.Token, target.ID, "replacement password")
				case "disable":
					_, err = service.AdminUpdateUser(t.Context(), actor.Token, target.ID, AdminUserPatch{Disabled: pointer(true)})
				case "delete":
					err = service.AdminDeleteUser(t.Context(), actor.Token, target.ID)
				case "role":
					_, err = service.AdminUpdateUser(t.Context(), actor.Token, target.ID, AdminUserPatch{Role: pointer("admin")})
				}
				if err != nil {
					t.Fatal(err)
				}
				return now()
			}
			session, err := service.Login(t.Context(), target.Username, "correct horse battery", "", "")
			if operation == "role" {
				if err != nil || session.User.Role != "admin" {
					t.Fatalf("login used stale role: %+v, %v", session.User, err)
				}
			} else if !errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("login survived concurrent %s: %v", operation, err)
			}
		})
	}
}

func TestAdminHashingOperationsRecheckRevokedActor(t *testing.T) {
	for _, operation := range []string{"create", "reset"} {
		t.Run(operation, func(t *testing.T) {
			service, _, actor := adminTestService(t)
			now := service.now
			// Revoke immediately after the initial reader check; the writer must recheck.
			service.now = func() time.Time {
				service.now = now
				if err := service.Logout(t.Context(), actor.Token); err != nil {
					t.Fatal(err)
				}
				return now()
			}
			var err error
			if operation == "create" {
				_, err = service.AdminCreateUser(t.Context(), actor.Token, CreateUserInput{
					Username: "new", Password: "correct horse battery",
				})
			} else {
				err = service.AdminResetPassword(t.Context(), actor.Token, actor.User.ID, "replacement password")
			}
			if !errors.Is(err, ErrInvalidSession) {
				t.Fatalf("revoked actor survived %s: %v", operation, err)
			}
		})
	}
}

func TestAdminRoleChangeRollsBackWhenSessionRevocationFails(t *testing.T) {
	service, databases, actor := adminTestService(t)
	target := adminCreate(t, service, actor, "reader", "user")
	if _, err := service.Login(t.Context(), target.Username, "correct horse battery", "", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := databases.Writer.ExecContext(t.Context(), `CREATE TRIGGER reject_session_revoke BEFORE DELETE ON sessions
		BEGIN SELECT RAISE(ABORT, 'test session revocation failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdminUpdateUser(t.Context(), actor.Token, target.ID, AdminUserPatch{Role: pointer("admin")}); err == nil {
		t.Fatal("role change ignored revocation failure")
	}
	current, err := service.AdminGetUser(t.Context(), actor.Token, target.ID)
	if err != nil || current.Role != "user" {
		t.Fatalf("role change was not rolled back: %+v, %v", current, err)
	}
}
