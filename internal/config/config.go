package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const bytesPerMiB = 1024 * 1024

// Config contains the settings used by the server.
type Config struct {
	DataDir        string
	Listen         string
	DropDir        string
	BookheapDir    string
	DropPoll       time.Duration
	BaseURL        *url.URL
	TrustedProxies []netip.Prefix
	MaxUploadBytes int64
	LogLevel       slog.Level
}

// Parse loads environment defaults and applies serve flags.
func Parse(args []string, output io.Writer) (Config, error) {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(output)
	dataDir := flags.String("data-dir", envOr("PANDA_DATA_DIR", "/data"), "runtime data directory")
	listen := flags.String("listen", envOr("PANDA_LISTEN", ":8080"), "HTTP listen address")
	dropDir := flags.String("drop-dir", os.Getenv("PANDA_DROP_DIR"), "import drop directory")
	bookheapDir := flags.String("bookheap-dir", os.Getenv("PANDA_BOOKHEAP_DIR"), "bookheap staging directory (default <data-dir>/bookheap)")
	dropPoll := flags.String("drop-poll", envOr("PANDA_DROP_POLL", "0"), "drop polling fallback interval (0 disables; otherwise at least 1s)")
	baseURL := flags.String("base-url", os.Getenv("PANDA_BASE_URL"), "public base URL")
	proxies := flags.String("trusted-proxies", os.Getenv("PANDA_TRUSTED_PROXIES"), "comma-separated trusted proxy CIDRs")
	maxUpload := flags.String("max-upload-mb", envOr("PANDA_MAX_UPLOAD_MB", "1024"), "maximum request body in MiB")
	logLevel := flags.String("log-level", envOr("PANDA_LOG_LEVEL", "info"), "log level: debug, info, warn, or error")
	if err := flags.Parse(args); err != nil {
		return Config{}, err
	}
	if flags.NArg() != 0 {
		return Config{}, fmt.Errorf("unexpected serve arguments: %s", strings.Join(flags.Args(), " "))
	}
	if *dataDir == "" {
		return Config{}, errors.New("data directory must not be empty")
	}
	if err := ValidateListen(*listen); err != nil {
		return Config{}, err
	}
	if *dropDir == "" {
		*dropDir = filepath.Join(*dataDir, "drop")
	}
	if *bookheapDir == "" {
		*bookheapDir = filepath.Join(*dataDir, "bookheap")
	}
	heapDir, err := filepath.Abs(*bookheapDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve bookheap directory: %w", err)
	}
	if err := ValidateBookheapDir(*dataDir, *dropDir, heapDir); err != nil {
		return Config{}, err
	}
	pollInterval, err := time.ParseDuration(*dropPoll)
	if err != nil || pollInterval < 0 || pollInterval > 0 && pollInterval < time.Second {
		return Config{}, errors.New("invalid drop polling interval: expected 0 or a duration of at least 1s")
	}
	publicURL, err := parseBaseURL(*baseURL)
	if err != nil {
		return Config{}, err
	}
	trustedProxies, err := parseProxies(*proxies)
	if err != nil {
		return Config{}, err
	}
	uploadMiB, err := strconv.ParseInt(*maxUpload, 10, 64)
	if err != nil || uploadMiB <= 0 || uploadMiB > math.MaxInt64/bytesPerMiB {
		return Config{}, fmt.Errorf("invalid maximum upload size %q: expected a positive MiB value without overflow", *maxUpload)
	}
	level, err := parseLogLevel(*logLevel)
	if err != nil {
		return Config{}, err
	}
	return Config{
		DataDir:        *dataDir,
		Listen:         *listen,
		DropDir:        *dropDir,
		BookheapDir:    heapDir,
		DropPoll:       pollInterval,
		BaseURL:        publicURL,
		TrustedProxies: trustedProxies,
		MaxUploadBytes: uploadMiB * bytesPerMiB,
		LogLevel:       level,
	}, nil
}

// ValidateBookheapDir rejects a heap directory that equals, contains or is inside
// the drop directory or a storage root (<data-dir>/{files,covers,assets,tmp,backups}),
// or that equals or contains the data (database) directory. Existing paths are
// compared after resolving symbolic links.
func ValidateBookheapDir(dataDir, dropDir, heapDir string) error {
	heap, err := resolvePath(heapDir)
	if err != nil {
		return fmt.Errorf("resolve bookheap directory: %w", err)
	}
	data, err := resolvePath(dataDir)
	if err != nil {
		return fmt.Errorf("resolve data directory: %w", err)
	}
	if within(data, heap) {
		return errors.New("invalid bookheap directory: it must not equal or contain the data directory")
	}
	guarded := map[string]string{"drop directory": dropDir}
	for _, name := range []string{"files", "covers", "assets", "tmp", "backups"} {
		guarded["data "+name+" directory"] = filepath.Join(dataDir, name)
	}
	for label, path := range guarded {
		resolved, err := resolvePath(path)
		if err != nil {
			return fmt.Errorf("resolve %s: %w", label, err)
		}
		if within(heap, resolved) || within(resolved, heap) {
			return fmt.Errorf("invalid bookheap directory: it must not equal, contain or be inside the %s", label)
		}
	}
	return nil
}

func resolvePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if resolved, err := filepath.EvalSymlinks(absolute); err == nil {
		return resolved, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	return absolute, nil
}

// within reports whether path equals or is inside parent.
func within(path, parent string) bool {
	relative, err := filepath.Rel(parent, path)
	return err == nil && (relative == "." || filepath.IsLocal(relative))
}

// ParseHealthcheckListen loads the local listen address for the healthcheck command.
func ParseHealthcheckListen(args []string, output io.Writer) (string, error) {
	flags := flag.NewFlagSet("healthcheck", flag.ContinueOnError)
	flags.SetOutput(output)
	listen := flags.String("listen", envOr("PANDA_LISTEN", ":8080"), "HTTP listen address to probe")
	if err := flags.Parse(args); err != nil {
		return "", err
	}
	if flags.NArg() != 0 {
		return "", fmt.Errorf("unexpected healthcheck arguments: %s", strings.Join(flags.Args(), " "))
	}
	if err := ValidateListen(*listen); err != nil {
		return "", err
	}
	return *listen, nil
}

// ValidateListen validates a TCP host:port address without resolving its host.
func ValidateListen(address string) error {
	host, port, err := net.SplitHostPort(address)
	if err != nil || strings.ContainsAny(host, " \t\r\n/\\?#@") {
		return fmt.Errorf("invalid listen address %q: expected host:port", address)
	}
	if strings.Trim(port, "0123456789") != "" {
		return fmt.Errorf("invalid listen port %q in %q", port, address)
	}
	if _, err := strconv.ParseUint(port, 10, 16); err != nil {
		return fmt.Errorf("invalid listen port %q in %q", port, address)
	}
	return nil
}

func parseBaseURL(value string) (*url.URL, error) {
	if value == "" {
		return nil, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Hostname() == "" || parsed.User != nil || parsed.ForceQuery || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("invalid base URL: expected an absolute HTTP(S) URL without credentials, query, or fragment")
	}
	return parsed, nil
}

func parseProxies(value string) ([]netip.Prefix, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	var prefixes []netip.Prefix
	for _, entry := range strings.Split(value, ",") {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(entry))
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q: %w", entry, err)
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

func parseLogLevel(value string) (slog.Level, error) {
	switch strings.ToLower(value) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid log level %q: expected debug, info, warn, or error", value)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
