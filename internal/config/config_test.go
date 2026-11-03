package config

import (
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func clearEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"PANDA_DATA_DIR", "PANDA_LISTEN", "PANDA_DROP_DIR", "PANDA_BASE_URL",
		"PANDA_TRUSTED_PROXIES", "PANDA_MAX_UPLOAD_MB", "PANDA_LOG_LEVEL",
		"PANDA_DROP_POLL",
	} {
		t.Setenv(key, "")
	}
}

func TestParseDefaultsAndOverrides(t *testing.T) {
	clearEnvironment(t)
	cfg, err := Parse(nil, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != "/data" || cfg.Listen != ":8080" ||
		cfg.DropDir != filepath.Join("/data", "drop") ||
		cfg.MaxUploadBytes != 1024*bytesPerMiB || cfg.LogLevel != slog.LevelInfo ||
		cfg.BaseURL != nil || len(cfg.TrustedProxies) != 0 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}

	t.Setenv("PANDA_DATA_DIR", "environment-data")
	t.Setenv("PANDA_LISTEN", ":9000")
	t.Setenv("PANDA_TRUSTED_PROXIES", "10.1.2.3/8, 2001:db8::1/32")
	cfg, err = Parse([]string{
		"--data-dir", "flag-data", "--listen", "127.0.0.1:1234",
		"--base-url", "https://books.example/path", "--max-upload-mb", "2",
		"--log-level", "debug",
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DataDir != "flag-data" || cfg.DropDir != filepath.Join("flag-data", "drop") ||
		cfg.Listen != "127.0.0.1:1234" || cfg.BaseURL.String() != "https://books.example/path" ||
		cfg.MaxUploadBytes != 2*bytesPerMiB || cfg.LogLevel != slog.LevelDebug {
		t.Fatalf("unexpected overrides: %+v", cfg)
	}
	if len(cfg.TrustedProxies) != 2 || cfg.TrustedProxies[0].String() != "10.0.0.0/8" ||
		cfg.TrustedProxies[1].String() != "2001:db8::/32" {
		t.Fatalf("unexpected proxy CIDRs: %v", cfg.TrustedProxies)
	}
}

func TestParseRejectsInvalidSettings(t *testing.T) {
	clearEnvironment(t)
	tests := []struct {
		args []string
		want string
	}{
		{[]string{"--data-dir", ""}, "data directory"},
		{[]string{"--listen", "localhost"}, "listen address"},
		{[]string{"--listen", ":+80"}, "listen port"},
		{[]string{"--listen", ":65536"}, "listen port"},
		{[]string{"--base-url", "ftp://example.com"}, "base URL"},
		{[]string{"--base-url", "https://user:pass@example.com"}, "base URL"},
		{[]string{"--trusted-proxies", "10.0.0.1"}, "proxy CIDR"},
		{[]string{"--trusted-proxies", "10.0.0.0/8,"}, "proxy CIDR"},
		{[]string{"--max-upload-mb", "0"}, "upload size"},
		{[]string{"--max-upload-mb", "8796093022208"}, "upload size"},
		{[]string{"--log-level", "quiet"}, "log level"},
		{[]string{"extra"}, "unexpected serve arguments"},
	}
	for _, test := range tests {
		_, err := Parse(test.args, io.Discard)
		if err == nil || !strings.Contains(err.Error(), test.want) {
			t.Errorf("Parse(%q) error = %v, want %q", test.args, err, test.want)
		}
	}
	_, err := Parse([]string{"--base-url", "https://user:secret@example.com"}, io.Discard)
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("base URL validation exposed credentials: %v", err)
	}
}

func TestParseHealthcheckListen(t *testing.T) {
	clearEnvironment(t)
	t.Setenv("PANDA_LISTEN", ":9000")
	listen, err := ParseHealthcheckListen([]string{"--listen", "[::1]:8080"}, io.Discard)
	if err != nil || listen != "[::1]:8080" {
		t.Fatalf("ParseHealthcheckListen() = %q, %v", listen, err)
	}
	if _, err := ParseHealthcheckListen([]string{"extra"}, io.Discard); err == nil {
		t.Fatal("unexpected argument accepted")
	}
}

func TestDropPollDefaultsValidationAndOverrides(t *testing.T) {
	clearEnvironment(t)
	cfg, err := Parse(nil, io.Discard)
	if err != nil || cfg.DropPoll != 0 {
		t.Fatalf("default poll %v %v", cfg.DropPoll, err)
	}
	t.Setenv("PANDA_DROP_POLL", "5s")
	cfg, err = Parse(nil, io.Discard)
	if err != nil || cfg.DropPoll != 5*time.Second {
		t.Fatalf("environment poll %v %v", cfg.DropPoll, err)
	}
	cfg, err = Parse([]string{"--drop-poll", "1m"}, io.Discard)
	if err != nil || cfg.DropPoll != time.Minute {
		t.Fatalf("flag poll %v %v", cfg.DropPoll, err)
	}
	for _, value := range []string{"-1s", "100ms", "bad", "5", "999999999999h"} {
		if _, err := Parse([]string{"--drop-poll", value}, io.Discard); err == nil {
			t.Errorf("accepted polling interval %q", value)
		}
	}
}
