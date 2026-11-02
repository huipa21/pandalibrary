package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"testing"
)

func TestCLI(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{name: "default serve", want: "pandalibrary: serve is not implemented"},
		{name: "serve", args: []string{"serve"}, want: "pandalibrary: serve is not implemented"},
		{name: "serve with arguments", args: []string{"serve", "--port", "8080"}, want: "pandalibrary: serve is not implemented"},
		{name: "migrate", args: []string{"migrate"}, want: "pandalibrary: migrate is not implemented"},
		{name: "migrate with subcommand", args: []string{"migrate", "status"}, want: "pandalibrary: migrate is not implemented"},
		{name: "healthcheck", args: []string{"healthcheck"}, want: "pandalibrary: healthcheck is not implemented"},
		{name: "user create", args: []string{"user", "create"}, want: "pandalibrary: user create is not implemented"},
		{name: "user reset-password", args: []string{"user", "reset-password"}, want: "pandalibrary: user reset-password is not implemented"},
		{name: "missing user subcommand", args: []string{"user"}, want: "pandalibrary: user requires a subcommand (create or reset-password)"},
		{name: "unknown user subcommand", args: []string{"user", "unknown"}, want: "pandalibrary: unknown user command \"unknown\""},
		{name: "unknown command", args: []string{"unknown"}, want: "pandalibrary: unknown command \"unknown\""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			args := append([]string{"-test.run=^TestCLIHelperProcess$", "--"}, tt.args...)
			cmd := exec.Command(os.Args[0], args...)
			cmd.Env = append(os.Environ(), "PANDALIBRARY_TEST_HELPER=1")
			var stdout, stderr bytes.Buffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr

			err := cmd.Run()
			var exitErr *exec.ExitError
			if !errors.As(err, &exitErr) {
				t.Fatalf("expected a non-zero exit, got %v", err)
			}
			if got := exitErr.ExitCode(); got != 1 {
				t.Errorf("exit code = %d, want 1", got)
			}
			if got := stdout.String(); got != "" {
				t.Errorf("stdout = %q, want empty", got)
			}
			if got := stderr.String(); got != tt.want+"\n" {
				t.Errorf("stderr = %q, want %q", got, tt.want+"\n")
			}
		})
	}
}

func TestCLIHelperProcess(t *testing.T) {
	if os.Getenv("PANDALIBRARY_TEST_HELPER") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append(os.Args[:1], os.Args[i+1:]...)
			main()
			return
		}
	}
	t.Fatal("missing argument separator")
}
