package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return notImplemented("serve")
	}
	switch args[0] {
	case "serve", "healthcheck":
		if len(args) != 1 {
			return fmt.Errorf("usage: pandalibrary %s", args[0])
		}
		return notImplemented(args[0])
	case "user":
		if len(args) != 2 || (args[1] != "create" && args[1] != "reset-password") {
			return errors.New("usage: pandalibrary user create|reset-password")
		}
		return notImplemented("user " + args[1])
	case "migrate":
		return runMigrate(args[1:], stdout)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func runMigrate(args []string, stdout io.Writer) (returnErr error) {
	if len(args) == 2 && args[0] == "new" {
		path, err := migrations.CreateSQLMigration(filepath.Join("internal", "db", "migrations"), args[1])
		if err != nil {
			return err
		}
		fmt.Fprintln(stdout, path)
		return nil
	}
	if len(args) == 1 && args[0] == "sum" {
		if err := migrations.GenerateSum(filepath.Join("internal", "db", "migrations")); err != nil {
			return err
		}
		return nil
	}
	if len(args) == 0 {
		return errors.New("usage: pandalibrary migrate status|up|down-to <version>")
	}

	command := args[0]
	switch command {
	case "status", "up":
		if len(args) != 1 {
			return errors.New("usage: pandalibrary migrate status|up")
		}
	case "down-to":
		if len(args) != 2 {
			return errors.New("usage: pandalibrary migrate down-to <version>")
		}
	default:
		return fmt.Errorf("unknown migrate command %q", command)
	}

	databases, err := db.Open(context.Background(), databasePath())
	if err != nil {
		return err
	}
	defer func() {
		if err := databases.Close(); err != nil {
			returnErr = errors.Join(returnErr, err)
		}
	}()
	options := migrations.DefaultOptions()
	runner, err := migrations.NewRunner(databases.Writer, databasePath(), migrations.Files(), options)
	if err != nil {
		return err
	}
	ctx := context.Background()
	switch command {
	case "status":
		current, latest, err := runner.Status(ctx)
		if err != nil {
			return err
		}
		state := "up to date"
		if current < latest {
			state = "pending"
		} else if current > latest {
			state = "database is newer than binary"
		}
		_, err = fmt.Fprintf(stdout, "Current version: %d\nLatest version: %d\nStatus: %s\n", current, latest, state)
		return err
	case "up":
		if err := runner.Up(ctx); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "Migrations are up to date.")
		return nil
	case "down-to":
		version, err := strconv.ParseInt(args[1], 10, 64)
		if err != nil || version < 0 {
			return fmt.Errorf("invalid migration version %q; expected a non-negative integer", args[1])
		}
		if err := runner.DownTo(ctx, version); err != nil {
			return err
		}
		fmt.Fprintf(stdout, "Migrated down to version %d.\n", version)
		return nil
	default:
		return fmt.Errorf("unsupported migration command %q", command)
	}
}

func databasePath() string {
	dataDir := os.Getenv("PANDA_DATA_DIR")
	if dataDir == "" {
		dataDir = "/data"
	}
	return filepath.Join(dataDir, "pandalibrary.db")
}

func notImplemented(command string) error {
	return fmt.Errorf("%s is not implemented", command)
}
