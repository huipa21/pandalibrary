package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestCommandDispatch(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "default serve", want: "serve is not implemented"},
		{name: "serve", args: []string{"serve"}, want: "serve is not implemented"},
		{name: "healthcheck", args: []string{"healthcheck"}, want: "healthcheck is not implemented"},
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
