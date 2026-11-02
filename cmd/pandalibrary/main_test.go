package main

import (
	"bytes"
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
		{name: "create user", args: []string{"user", "create"}, want: "user create is not implemented"},
		{name: "reset password", args: []string{"user", "reset-password"}, want: "user reset-password is not implemented"},
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
