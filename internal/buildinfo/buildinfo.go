// Package buildinfo resolves and validates the application's build provenance.
package buildinfo

import (
	"errors"
	"fmt"
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

var (
	stampCommit     string
	stampCommitDate string
	stampDirty      string
	stampRelease    string
)

var (
	commitPattern  = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
	datePattern    = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$`)
	releasePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$`)
)

// ErrUnavailable indicates that trustworthy build provenance could not be resolved.
var ErrUnavailable = errors.New("build provenance unavailable")

// Stamp contains the raw values supplied by the build system or Git.
type Stamp struct {
	Commit     string
	CommitDate string
	Dirty      string
	Release    string
}

// Info contains only public, normalized build metadata.
type Info struct {
	Version    string  `json:"version"`
	Commit     string  `json:"commit"`
	CommitDate string  `json:"commit_date"`
	Dirty      bool    `json:"dirty"`
	Release    *string `json:"release"`
}

// New validates a complete stamp and derives its UTC commit-based version.
func New(stamp Stamp) (Info, error) {
	commit := strings.ToLower(stamp.Commit)
	if !commitPattern.MatchString(commit) {
		return Info{}, fmt.Errorf("%w: commit must be a full Git object ID", ErrUnavailable)
	}
	if !datePattern.MatchString(stamp.CommitDate) {
		return Info{}, fmt.Errorf("%w: commit date must be an RFC3339 timestamp with second precision", ErrUnavailable)
	}
	if len(stamp.CommitDate) == len("2006-01-02T15:04:05-07:00") {
		offset := stamp.CommitDate[len(stamp.CommitDate)-5:]
		if offset[:2] > "23" || offset[3:] > "59" {
			return Info{}, fmt.Errorf("%w: commit date has an invalid UTC offset", ErrUnavailable)
		}
	}
	committed, err := time.Parse(time.RFC3339, stamp.CommitDate)
	if err != nil {
		return Info{}, fmt.Errorf("%w: invalid commit date", ErrUnavailable)
	}
	committed = committed.UTC()
	if committed.Year() < 1 || committed.Year() > 9999 {
		return Info{}, fmt.Errorf("%w: commit date is outside the supported UTC range", ErrUnavailable)
	}
	if stamp.Dirty != "true" && stamp.Dirty != "false" {
		return Info{}, fmt.Errorf("%w: dirty state must be true or false", ErrUnavailable)
	}
	var release *string
	if stamp.Release != "" {
		if !releasePattern.MatchString(stamp.Release) {
			return Info{}, fmt.Errorf("%w: release tag contains unsupported characters", ErrUnavailable)
		}
		release = &stamp.Release
	}
	dirty := stamp.Dirty == "true"
	version := committed.Format("20060102-150405") + "+" + commit[:12]
	if dirty {
		version += "-dirty"
	}
	return Info{
		Version: version, Commit: commit, CommitDate: committed.Format(time.RFC3339),
		Dirty: dirty, Release: release,
	}, nil
}

// Display includes the optional release tag without replacing commit provenance.
func (info Info) Display() string {
	if info.Release == nil {
		return info.Version
	}
	return info.Version + " (release " + *info.Release + ")"
}

var (
	currentOnce sync.Once
	currentInfo Info
	currentErr  error
)

// Current resolves provenance once for this process. Invalid stamps never fall back
// to another source, and Git is consulted only for an unstamped go-run executable.
func Current() (Info, error) {
	currentOnce.Do(func() {
		info, _ := debug.ReadBuildInfo()
		currentInfo, currentErr = resolve(Stamp{
			Commit: stampCommit, CommitDate: stampCommitDate,
			Dirty: stampDirty, Release: stampRelease,
		}, info, goRunStamp)
	})
	return currentInfo, currentErr
}

func resolve(stamp Stamp, info *debug.BuildInfo, devStamp func() (Stamp, error)) (Info, error) {
	if stamp != (Stamp{}) {
		return New(stamp)
	}
	vcs, present := vcsStamp(info)
	if present {
		return New(vcs)
	}
	stamp, err := devStamp()
	if err != nil {
		return Info{}, err
	}
	return New(stamp)
}

func vcsStamp(info *debug.BuildInfo) (Stamp, bool) {
	if info == nil {
		return Stamp{}, false
	}
	settings := make(map[string]string)
	for _, setting := range info.Settings {
		if strings.HasPrefix(setting.Key, "vcs") {
			settings[setting.Key] = setting.Value
		}
	}
	if len(settings) == 0 {
		return Stamp{}, false
	}
	if settings["vcs"] != "git" {
		return Stamp{}, true
	}
	return Stamp{
		Commit: settings["vcs.revision"], CommitDate: settings["vcs.time"],
		Dirty: settings["vcs.modified"],
	}, true
}
