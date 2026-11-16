package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	_ "time/tzdata"

	"pandalibrary/internal/app"
	"pandalibrary/internal/auth"
	"pandalibrary/internal/backup"
	"pandalibrary/internal/buildinfo"
	"pandalibrary/internal/config"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"

	"golang.org/x/term"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || strings.HasPrefix(args[0], "-") {
		return runServe(args, stderr)
	}
	switch args[0] {
	case "serve":
		return runServe(args[1:], stderr)
	case "healthcheck":
		return runHealthcheck(args[1:], stderr)
	case "version":
		if len(args) != 1 {
			return fmt.Errorf("version does not accept arguments")
		}
		return writeVersion(stdout, buildinfo.Current)
	case "user":
		return runUser(args[1:], stdout, stderr)
	case "migrate":
		return runMigrate(args[1:], stdout)
	case "restore":
		return runRestore(args[1:], stdout, stderr)
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func writeVersion(stdout io.Writer, resolve func() (buildinfo.Info, error)) error {
	info, err := resolve()
	if err != nil {
		return fmt.Errorf("version unavailable: %w", err)
	}
	_, err = fmt.Fprintln(stdout, info.Display())
	return err
}

func runServe(args []string, stderr io.Writer) error {
	cfg, err := config.Parse(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewJSONHandler(stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return app.Run(ctx, cfg, logger)
}

func runHealthcheck(args []string, stderr io.Writer) error {
	listen, err := config.ParseHealthcheckListen(args, stderr)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	return app.Healthcheck(context.Background(), listen)
}

type passwordPrompt func(string) (string, error)

func runUser(args []string, stdout, stderr io.Writer) error {
	return runUserWithPrompt(args, stdout, stderr, readPasswordFromTerminal)
}

func runUserWithPrompt(args []string, stdout, stderr io.Writer, prompt passwordPrompt) (returnErr error) {
	if len(args) == 0 {
		return errors.New("usage: pandalibrary user create|reset-password")
	}
	command := args[0]
	if command != "create" && command != "reset-password" {
		return fmt.Errorf("unknown user command %q", command)
	}
	flags := flag.NewFlagSet("user "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	username := flags.String("username", "", "username to create or reset")
	admin := flags.Bool("admin", false, "create an administrator")
	if err := flags.Parse(args[1:]); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected user arguments: %s", strings.Join(flags.Args(), " "))
	}
	if *username == "" {
		return errors.New("user command requires --username")
	}
	if command == "reset-password" && *admin {
		return errors.New("--admin is only valid with user create")
	}

	password, err := prompt("New password")
	if err != nil {
		return err
	}
	confirmationPrompt := "Confirm password"
	if command == "reset-password" {
		confirmationPrompt = "Confirm new password"
	}
	confirmation, err := prompt(confirmationPrompt)
	if err != nil {
		return err
	}
	if password != confirmation {
		return errors.New("passwords do not match")
	}

	ctx := context.Background()
	dataLock, err := backup.Acquire(filepath.Dir(databasePath()))
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, dataLock.Close()) }()
	databases, err := db.Open(ctx, databasePath())
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer func() {
		if err := databases.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close database: %w", err))
		}
	}()
	migrationRunner, err := migrations.NewRunner(
		databases.Writer, databasePath(), migrations.Files(), migrations.DefaultOptions(),
	)
	if err != nil {
		return fmt.Errorf("configure migrations: %w", err)
	}
	if err := migrationRunner.Run(ctx); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}
	service, err := auth.NewService(ctx, databases.Writer, databases.Reader, false)
	if err != nil {
		return fmt.Errorf("configure authentication: %w", err)
	}
	if command == "reset-password" {
		if err := service.ResetPassword(ctx, *username, password); err != nil {
			return fmt.Errorf("reset password: %w", err)
		}
		_, err := fmt.Fprintf(stdout, "Password reset for %s.\n", strings.TrimSpace(*username))
		return err
	}
	role := "user"
	if *admin {
		role = "admin"
	}
	user, err := service.CreateUser(ctx, auth.CreateUserInput{
		Username: *username, Password: password, Role: role, Locale: "en",
	})
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	_, err = fmt.Fprintf(stdout, "Created %s user %s (id %d).\n", user.Role, user.Username, user.ID)
	return err
}

func readPasswordFromTerminal(prompt string) (string, error) {
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return "", errors.New("secure password input requires an interactive terminal")
	}
	if _, err := fmt.Fprintf(os.Stderr, "%s: ", prompt); err != nil {
		return "", err
	}
	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	_, writeErr := fmt.Fprintln(os.Stderr)
	if err != nil {
		clear(password)
		return "", fmt.Errorf("read password securely: %w", err)
	}
	if writeErr != nil {
		clear(password)
		return "", writeErr
	}
	result := string(password)
	clear(password)
	return result, nil
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

	dataLock, err := backup.Acquire(filepath.Dir(databasePath()))
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, dataLock.Close()) }()
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

func runRestore(args []string, stdout, stderr io.Writer) (returnErr error) {
	flags := flag.NewFlagSet("restore", flag.ContinueOnError)
	flags.SetOutput(stderr)
	filename := flags.String("file", "", "full-data .tar.gz archive")
	dataDir := flags.String("data-dir", filepath.Dir(databasePath()), "target data directory")
	confirm := flags.Bool("confirm", false, "confirm replacement of all app data on next startup")
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if *filename == "" || !*confirm || flags.NArg() != 0 {
		return errors.New("usage: pandalibrary restore --file <archive.tar.gz> --data-dir <directory> --confirm (server must be stopped)")
	}
	cfg, err := config.Parse([]string{"--data-dir", *dataDir}, stderr)
	if err != nil {
		return err
	}
	lock, err := backup.Acquire(cfg.DataDir)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, lock.Close()) }()
	service, err := backup.New(cfg, nil, nil)
	if err != nil {
		return err
	}
	file, err := os.Open(*filename)
	if err != nil {
		return err
	}
	defer func() { returnErr = errors.Join(returnErr, file.Close()) }()
	if err := service.Stage(context.Background(), file); err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, "Restore validated and staged. Restart required: start PandaLibrary with the same data/drop/bookheap configuration to apply it.")
	return err
}
