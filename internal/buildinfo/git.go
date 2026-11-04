package buildinfo

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

var (
	goRunWorkDir = regexp.MustCompile(`^go-build[0-9]+$`)
	goRunPackage = regexp.MustCompile(`^b[0-9]+$`)
	goRunCached  = regexp.MustCompile(`^[0-9a-f]{64}-d$`)
)

func goRunStamp() (Stamp, error) {
	executable, err := os.Executable()
	if err != nil || !isGoRunExecutable(executable) {
		return Stamp{}, fmt.Errorf("%w: no stamp or VCS metadata in a non-development binary", ErrUnavailable)
	}
	_, source, _, ok := runtime.Caller(0)
	source = filepath.FromSlash(source)
	if !ok || !filepath.IsAbs(source) {
		return Stamp{}, fmt.Errorf("%w: cannot locate the go-run source checkout", ErrUnavailable)
	}
	root := filepath.Dir(filepath.Dir(filepath.Dir(source)))
	return checkoutStamp(root)
}

func isGoRunExecutable(executable string) bool {
	exeDir := filepath.Dir(executable)
	packageDir := filepath.Dir(exeDir)
	workDir := filepath.Dir(packageDir)
	if filepath.Base(exeDir) == "exe" &&
		goRunPackage.MatchString(filepath.Base(packageDir)) &&
		goRunWorkDir.MatchString(filepath.Base(workDir)) {
		return true
	}

	// Recent Go versions can execute a cached binary instead of a temporary one.
	entry := filepath.Base(exeDir)
	if !goRunCached.MatchString(entry) || filepath.Base(packageDir) != entry[:2] {
		return false
	}
	if cache := os.Getenv("GOCACHE"); cache != "" {
		return sameDirectory(workDir, cache)
	}
	if cache, err := os.UserCacheDir(); err == nil && sameDirectory(workDir, filepath.Join(cache, "go-build")) {
		return true
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "go", "env", "GOCACHE").Output()
	return err == nil && sameDirectory(workDir, strings.TrimSpace(string(output)))
}

func sameDirectory(first, second string) bool {
	if !filepath.IsAbs(first) || !filepath.IsAbs(second) {
		return false
	}
	firstInfo, err := os.Stat(first)
	if err != nil {
		return false
	}
	secondInfo, err := os.Stat(second)
	return err == nil && os.SameFile(firstInfo, secondInfo)
}

func checkoutStamp(root string) (Stamp, error) {
	top, err := git(root, "rev-parse", "--show-toplevel")
	if err != nil {
		return Stamp{}, err
	}
	if !sameDirectory(root, strings.TrimSpace(string(top))) {
		return Stamp{}, fmt.Errorf("%w: source directory is not the Git checkout root", ErrUnavailable)
	}
	commit, err := git(root, "show", "-s", "--no-show-signature", "--format=%H%n%cI", "HEAD")
	if err != nil {
		return Stamp{}, err
	}
	fields := strings.Split(strings.TrimSpace(string(commit)), "\n")
	if len(fields) != 2 {
		return Stamp{}, fmt.Errorf("%w: Git returned incomplete commit metadata", ErrUnavailable)
	}
	status, err := git(root, "status", "--porcelain=v1", "-z", "--untracked-files=normal")
	if err != nil {
		return Stamp{}, err
	}
	head, err := git(root, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return Stamp{}, err
	}
	if strings.TrimSpace(string(head)) != fields[0] {
		return Stamp{}, fmt.Errorf("%w: HEAD changed while resolving the commit", ErrUnavailable)
	}
	dirty := "false"
	if len(status) != 0 {
		dirty = "true"
	}
	return Stamp{Commit: fields[0], CommitDate: fields[1], Dirty: dirty}, nil
}

func git(root string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root, "--no-pager"}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("%w: Git %s failed: %w", ErrUnavailable, args[0], err)
	}
	return output, nil
}
