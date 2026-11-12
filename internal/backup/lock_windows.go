package backup

import (
	"os"

	"golang.org/x/sys/windows"
)

func lockFile(file *os.File) error {
	return windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &windows.Overlapped{})
}

// Windows does not support syncing directory handles through os.File.Sync.
// File contents and the recovery journal are still explicitly flushed.
func syncDirectory(string) error { return nil }
