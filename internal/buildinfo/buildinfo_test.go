package buildinfo

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"runtime/debug"
	"strings"
	"testing"
)

const testCommit = "0123456789abcdef0123456789abcdef01234567"

func TestNewNormalizesCommitProvenance(t *testing.T) {
	stamp := Stamp{
		Commit: strings.ToUpper(testCommit), CommitDate: "2026-01-01T00:30:45+09:30",
		Dirty: "true", Release: "release/v1.2.3+build",
	}
	info, err := New(stamp)
	if err != nil {
		t.Fatal(err)
	}
	if info.Version != "20251231-150045+0123456789ab-dirty" ||
		info.Commit != testCommit || info.CommitDate != "2025-12-31T15:00:45Z" ||
		!info.Dirty || info.Release == nil || *info.Release != stamp.Release ||
		info.Display() != "20251231-150045+0123456789ab-dirty (release release/v1.2.3+build)" {
		t.Fatalf("normalized metadata = %+v", info)
	}
	stamp.Commit = strings.Repeat("a", 64)
	stamp.Dirty = "false"
	stamp.Release = ""
	info, err = New(stamp)
	if err != nil || info.Version != "20251231-150045+aaaaaaaaaaaa" || info.Release != nil {
		t.Fatalf("SHA-256 metadata = %+v, %v", info, err)
	}
}

func TestNewRejectsInvalidOrIncompleteStamps(t *testing.T) {
	valid := Stamp{Commit: testCommit, CommitDate: "2026-01-01T00:00:00Z", Dirty: "false"}
	tests := map[string]func(*Stamp){
		"missing commit":     func(s *Stamp) { s.Commit = "" },
		"short commit":       func(s *Stamp) { s.Commit = testCommit[:12] },
		"non-hex commit":     func(s *Stamp) { s.Commit = strings.Repeat("g", 40) },
		"missing date":       func(s *Stamp) { s.CommitDate = "" },
		"invalid date":       func(s *Stamp) { s.CommitDate = "2026-02-30T00:00:00Z" },
		"missing timezone":   func(s *Stamp) { s.CommitDate = "2026-01-01T00:00:00" },
		"fractional seconds": func(s *Stamp) { s.CommitDate = "2026-01-01T00:00:00.1Z" },
		"invalid UTC offset": func(s *Stamp) { s.CommitDate = "2026-01-01T00:00:00+24:00" },
		"missing dirty":      func(s *Stamp) { s.Dirty = "" },
		"invalid dirty":      func(s *Stamp) { s.Dirty = "yes" },
		"unsafe release":     func(s *Stamp) { s.Release = "tag with spaces" },
		"release injection":  func(s *Stamp) { s.Release = "v1\" -X secret=value" },
		"long release":       func(s *Stamp) { s.Release = strings.Repeat("a", 129) },
	}
	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			stamp := valid
			change(&stamp)
			if _, err := New(stamp); !errors.Is(err, ErrUnavailable) {
				t.Fatalf("New(%+v) error = %v", stamp, err)
			}
		})
	}
}

func TestResolvePrecedenceAndInvalidSources(t *testing.T) {
	stamp := Stamp{Commit: testCommit, CommitDate: "2026-01-01T00:00:00Z", Dirty: "true", Release: "v1"}
	vcs := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "vcs", Value: "git"},
		{Key: "vcs.revision", Value: strings.Repeat("a", 40)},
		{Key: "vcs.time", Value: "2024-01-02T03:04:05Z"},
		{Key: "vcs.modified", Value: "false"},
	}}
	devCalls := 0
	dev := func() (Stamp, error) {
		devCalls++
		return Stamp{Commit: strings.Repeat("b", 40), CommitDate: "2023-01-01T00:00:00Z", Dirty: "false"}, nil
	}
	info, err := resolve(stamp, vcs, dev)
	if err != nil || info.Commit != testCommit || info.Release == nil || devCalls != 0 {
		t.Fatalf("stamp precedence: %+v, %v, dev calls %d", info, err, devCalls)
	}
	info, err = resolve(Stamp{}, vcs, dev)
	if err != nil || info.Commit != strings.Repeat("a", 40) || info.Dirty || devCalls != 0 {
		t.Fatalf("VCS precedence: %+v, %v, dev calls %d", info, err, devCalls)
	}
	info, err = resolve(Stamp{}, nil, dev)
	if err != nil || info.Commit != strings.Repeat("b", 40) || devCalls != 1 {
		t.Fatalf("development fallback: %+v, %v, dev calls %d", info, err, devCalls)
	}
	for _, invalid := range []struct {
		stamp Stamp
		info  *debug.BuildInfo
	}{
		{stamp: Stamp{Commit: "invalid"}, info: vcs},
		{stamp: Stamp{Release: "v1"}, info: vcs},
		{info: &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs", Value: "git"}}}},
		{info: &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs", Value: "hg"}}}},
	} {
		if _, err := resolve(invalid.stamp, invalid.info, dev); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("invalid source resolved successfully: %v", err)
		}
	}
	if devCalls != 1 {
		t.Fatalf("invalid provenance unexpectedly fell back to Git: %d calls", devCalls)
	}
	if _, err := resolve(Stamp{}, nil, func() (Stamp, error) {
		return Stamp{}, fmt.Errorf("source unavailable: %w", ErrUnavailable)
	}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("development resolution error = %v", err)
	}
}

func TestGoRunExecutableDetection(t *testing.T) {
	good := filepath.Join(t.TempDir(), "go-build12345", "b001", "exe", "pandalibrary")
	if !isGoRunExecutable(good) {
		t.Fatal("go-run executable was not recognized")
	}
	cache := filepath.Join(t.TempDir(), "custom cache with spaces")
	if err := os.Mkdir(cache, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOCACHE", cache)
	cached := filepath.Join(cache, "aa", strings.Repeat("a", 64)+"-d", "pandalibrary")
	if !isGoRunExecutable(cached) {
		t.Fatal("cached go-run executable was not recognized")
	}
	for _, executable := range []string{
		filepath.Join(t.TempDir(), "pandalibrary"),
		filepath.Join(t.TempDir(), "go-build123", "b001", "pandalibrary"),
		filepath.Join(t.TempDir(), "go-buildfake", "b001", "exe", "pandalibrary"),
		filepath.Join(t.TempDir(), "go-build123", "other", "exe", "pandalibrary"),
		filepath.Join(cache, "bb", strings.Repeat("a", 64)+"-d", "pandalibrary"),
		filepath.Join(t.TempDir(), "aa", strings.Repeat("a", 64)+"-d", "pandalibrary"),
	} {
		if isGoRunExecutable(executable) {
			t.Fatalf("ordinary executable recognized as go run: %q", executable)
		}
	}
}

func TestCheckoutStampShallowAndDirty(t *testing.T) {
	requireTool(t, "git")
	parent := t.TempDir()
	origin := filepath.Join(parent, "origin with spaces")
	if err := os.Mkdir(origin, 0o755); err != nil {
		t.Fatal(err)
	}
	testGit(t, origin, "init", "--quiet")
	file := filepath.Join(origin, "tracked.txt")
	if err := os.WriteFile(file, []byte("first\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	testGit(t, origin, "add", "tracked.txt")
	testGit(t, origin, "commit", "--quiet", "-m", "first")
	if err := os.WriteFile(file, []byte("second\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	testGit(t, origin, "add", "tracked.txt")
	testGit(t, origin, "commit", "--quiet", "-m", "second")

	path := filepath.ToSlash(origin)
	if runtime.GOOS == "windows" {
		path = "/" + path
	}
	remote := (&url.URL{Scheme: "file", Path: path}).String()
	clone := filepath.Join(parent, "shallow checkout with spaces")
	testGit(t, parent, "clone", "--quiet", "--depth=1", remote, clone)
	if got := testGit(t, clone, "rev-parse", "--is-shallow-repository"); got != "true" {
		t.Fatalf("fixture is not shallow: %q", got)
	}
	stamp, err := checkoutStamp(clone)
	if err != nil {
		t.Fatal(err)
	}
	info, err := New(stamp)
	if err != nil || info.Commit != testGit(t, clone, "rev-parse", "HEAD") ||
		info.CommitDate != "2025-12-31T15:00:45Z" || info.Dirty {
		t.Fatalf("clean checkout metadata = %+v, %v", info, err)
	}
	if err := os.WriteFile(filepath.Join(clone, "untracked.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatal(err)
	}
	stamp, err = checkoutStamp(clone)
	if err != nil || stamp.Dirty != "true" {
		t.Fatalf("dirty checkout metadata = %+v, %v", stamp, err)
	}
	if _, err := checkoutStamp(filepath.Join(clone, ".git")); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("non-root checkout accepted: %v", err)
	}
}

func TestActualGoRunAndBuiltMetadata(t *testing.T) {
	requireTool(t, "go")
	requireTool(t, "git")
	_, source, _, _ := runtime.Caller(0)
	root := filepath.Dir(filepath.Dir(filepath.Dir(source)))
	probe := "./internal/buildinfo/testdata/probe"
	stamp, err := checkoutStamp(root)
	if err != nil {
		t.Fatal(err)
	}
	expected, err := New(stamp)
	if err != nil {
		t.Fatal(err)
	}
	var actual Info
	for attempt := 0; attempt < 2; attempt++ {
		run := exec.Command("go", "run", probe)
		run.Dir = root
		run.Env = append(os.Environ(), "TZ=Pacific/Honolulu")
		output, err := run.CombinedOutput()
		if err != nil {
			t.Fatalf("go run probe: %v\n%s", err, output)
		}
		if err := json.Unmarshal(output, &actual); err != nil || !reflect.DeepEqual(actual, expected) {
			t.Fatalf("go run metadata = %+v, want %+v (%v): %s", actual, expected, err, output)
		}
	}

	binary := filepath.Join(t.TempDir(), "probe")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	buildProbe(t, root, binary, probe, "")
	actual = runProbe(t, binary, false)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("ordinary build metadata = %+v, want %+v", actual, expected)
	}

	flags := "-X pandalibrary/internal/buildinfo.stampCommit=" + testCommit +
		" -X pandalibrary/internal/buildinfo.stampCommitDate=2026-01-01T00:30:45+09:30" +
		" -X pandalibrary/internal/buildinfo.stampDirty=true" +
		" -X pandalibrary/internal/buildinfo.stampRelease=v1.2.3"
	buildProbe(t, root, binary, probe, flags)
	actual = runProbe(t, binary, false)
	if actual.Version != "20251231-150045+0123456789ab-dirty" ||
		actual.Release == nil || *actual.Release != "v1.2.3" {
		t.Fatalf("injected stamp did not override VCS metadata: %+v", actual)
	}

	buildProbe(t, root, binary, probe, "-X pandalibrary/internal/buildinfo.stampCommit=invalid")
	runProbe(t, binary, true)
}

func requireTool(t *testing.T, name string) {
	t.Helper()
	if _, err := exec.LookPath(name); err != nil {
		t.Skipf("%s is required for this provenance integration test: %v", name, err)
	}
}

func testGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=Fixture", "GIT_AUTHOR_EMAIL=fixture@example.invalid",
		"GIT_COMMITTER_NAME=Fixture", "GIT_COMMITTER_EMAIL=fixture@example.invalid",
		"GIT_AUTHOR_DATE=2026-01-01T00:30:45+09:30", "GIT_COMMITTER_DATE=2026-01-01T00:30:45+09:30",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

func buildProbe(t *testing.T, root, binary, probe, flags string) {
	t.Helper()
	args := []string{"build", "-o", binary}
	if flags != "" {
		args = append(args, "-ldflags", flags)
	}
	cmd := exec.Command("go", append(args, probe)...)
	cmd.Dir = root
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build probe: %v\n%s", err, output)
	}
}

func runProbe(t *testing.T, binary string, wantFailure bool) Info {
	t.Helper()
	cmd := exec.Command(binary)
	cmd.Dir = t.TempDir()
	cmd.Env = append(os.Environ(), "PATH=")
	output, err := cmd.CombinedOutput()
	if wantFailure {
		if err == nil || !strings.Contains(string(output), "build provenance unavailable") {
			t.Fatalf("invalid stamp: %v\n%s", err, output)
		}
		return Info{}
	}
	if err != nil {
		t.Fatalf("built probe without Git: %v\n%s", err, output)
	}
	var info Info
	if err := json.Unmarshal(output, &info); err != nil {
		t.Fatalf("decode built probe: %v\n%s", err, output)
	}
	return info
}
