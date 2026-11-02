package main

import (
	"bytes"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCommandDispatch(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "create user requires username", args: []string{"user", "create"}, want: "requires --username"},
		{name: "reset password requires username", args: []string{"user", "reset-password"}, want: "requires --username"},
		{name: "unknown user command", args: []string{"user", "delete"}, want: `unknown user command "delete"`},
		{name: "unknown", args: []string{"unknown"}, want: `unknown command "unknown"`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			err := run(test.args, &stdout, &stderr)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("run() error = %v, want text %q", err, test.want)
			}
		})
	}
}

func TestUserCreateAndResetPassword(t *testing.T) {
	t.Setenv("PANDA_DATA_DIR", t.TempDir())
	passwords := []string{"correct horse battery", "correct horse battery"}
	var stdout, stderr bytes.Buffer
	prompt := func(string) (string, error) {
		if len(passwords) == 0 {
			t.Fatal("password prompt called more than expected")
		}
		password := passwords[0]
		passwords = passwords[1:]
		return password, nil
	}
	if err := runUserWithPrompt(
		[]string{"create", "--username", "library-admin", "--admin"},
		&stdout, &stderr, prompt,
	); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	if !strings.Contains(stdout.String(), "Created admin user library-admin") ||
		strings.Contains(stdout.String(), "correct horse battery") {
		t.Fatalf("create output is incorrect or contains a password: %q", stdout.String())
	}

	passwords = []string{"different correct password", "different correct password"}
	stdout.Reset()
	if err := runUserWithPrompt(
		[]string{"reset-password", "--username", "library-admin"},
		&stdout, &stderr, prompt,
	); err != nil {
		t.Fatalf("reset password: %v", err)
	}
	if !strings.Contains(stdout.String(), "Password reset for library-admin") ||
		strings.Contains(stdout.String(), "different correct password") {
		t.Fatalf("reset output is incorrect or contains a password: %q", stdout.String())
	}
}

func TestUserPasswordPromptFailures(t *testing.T) {
	var stdout, stderr bytes.Buffer
	passwords := []string{"first correct password", "second correct password"}
	prompt := func(string) (string, error) {
		password := passwords[0]
		passwords = passwords[1:]
		return password, nil
	}
	if err := runUserWithPrompt(
		[]string{"create", "--username", "admin"}, &stdout, &stderr, prompt,
	); err == nil || !strings.Contains(err.Error(), "do not match") {
		t.Fatalf("mismatched confirmation error = %v", err)
	}
	if err := runUserWithPrompt(
		[]string{"reset-password", "--username", "admin", "extra"}, &stdout, &stderr, prompt,
	); err == nil || !strings.Contains(err.Error(), "unexpected user arguments") {
		t.Fatalf("unexpected positional argument error = %v", err)
	}
	if err := runUserWithPrompt(
		[]string{"reset-password", "--username", "admin", "--admin"}, &stdout, &stderr, prompt,
	); err == nil || !strings.Contains(err.Error(), "--admin is only valid") {
		t.Fatalf("invalid reset flag error = %v", err)
	}
	promptErr := errors.New("password input failed")
	if err := runUserWithPrompt(
		[]string{"reset-password", "--username", "admin"}, &stdout, &stderr,
		func(string) (string, error) { return "", promptErr },
	); !errors.Is(err, promptErr) {
		t.Fatalf("secure prompt error = %v", err)
	}
}

func TestServeDispatchAndHealthcheck(t *testing.T) {
	t.Setenv("PANDA_MAX_UPLOAD_MB", "invalid")
	for _, args := range [][]string{nil, {"serve"}, {"--max-upload-mb", "invalid"}} {
		err := run(args, &bytes.Buffer{}, &bytes.Buffer{})
		if err == nil || !strings.Contains(err.Error(), "upload size") {
			t.Fatalf("run(%q) error = %v, want serve configuration error", args, err)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	host, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"healthcheck", "--listen", net.JoinHostPort(host, port)}, &bytes.Buffer{}, &bytes.Buffer{}); err != nil {
		t.Fatalf("healthcheck: %v", err)
	}
}

func TestMigrateArgumentValidation(t *testing.T) {
	tests := [][]string{
		{"migrate"},
		{"migrate", "unknown"},
		{"migrate", "status", "extra"},
		{"migrate", "down-to", "not-a-number"},
		{"user"},
	}
	for _, args := range tests {
		if err := run(args, &bytes.Buffer{}, &bytes.Buffer{}); err == nil {
			t.Errorf("run(%q) unexpectedly succeeded", args)
		}
	}
}
