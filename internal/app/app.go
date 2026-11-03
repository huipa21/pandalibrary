package app

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/blobstore"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/config"
	"pandalibrary/internal/db"
	"pandalibrary/internal/db/migrations"
	"pandalibrary/internal/httpapi"
	"pandalibrary/internal/jobs"
	"pandalibrary/internal/reading"
	webui "pandalibrary/web"
)

const shutdownTimeout = 10 * time.Second

type application struct {
	databases *db.DB
	handler   http.Handler
	scheduler *jobs.Scheduler
	ready     atomic.Bool
	logger    *slog.Logger
}

func newApplication(ctx context.Context, cfg config.Config, logger *slog.Logger) (_ *application, returnErr error) {
	if logger == nil {
		return nil, errors.New("application logger must not be nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, directory := range []string{
		cfg.DataDir, filepath.Join(cfg.DataDir, "files"), filepath.Join(cfg.DataDir, "covers"),
		filepath.Join(cfg.DataDir, "tmp"), filepath.Join(cfg.DataDir, "backups"), cfg.DropDir,
	} {
		if err := os.MkdirAll(directory, 0o750); err != nil {
			return nil, fmt.Errorf("create runtime directory %q: %w", directory, err)
		}
	}
	path := filepath.Join(cfg.DataDir, "pandalibrary.db")
	databases, err := db.Open(ctx, path)
	if err != nil {
		return nil, fmt.Errorf("open application database: %w", err)
	}
	defer func() {
		if returnErr != nil {
			if err := databases.Close(); err != nil {
				returnErr = errors.Join(returnErr, fmt.Errorf("close application database after startup failure: %w", err))
			}
		}
	}()
	runner, err := migrations.NewRunner(databases.Writer, path, migrations.Files(), migrations.DefaultOptions())
	if err != nil {
		return nil, fmt.Errorf("configure startup migrations: %w", err)
	}
	if err := runner.Run(ctx); err != nil {
		return nil, fmt.Errorf("run startup migrations: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	assets, err := fs.Sub(webui.Files, "build")
	if err != nil {
		return nil, fmt.Errorf("open embedded web assets: %w", err)
	}
	scheduler, err := jobs.NewScheduler(logger)
	if err != nil {
		return nil, fmt.Errorf("configure scheduler: %w", err)
	}
	authentication, err := auth.NewService(ctx, databases.Writer, databases.Reader,
		cfg.BaseURL != nil && cfg.BaseURL.Scheme == "https")
	if err != nil {
		return nil, fmt.Errorf("configure authentication: %w", err)
	}
	if token := authentication.InitialSetupToken(); token != "" {
		logger.Warn("initial administrator setup is required", "setup_token", token)
	}
	blobs, err := blobstore.New(cfg.DataDir)
	if err != nil {
		return nil, fmt.Errorf("configure blob storage: %w", err)
	}
	catalogService, err := catalog.NewService(databases.Writer, databases.Reader, blobs)
	if err != nil {
		return nil, fmt.Errorf("configure catalog: %w", err)
	}
	readingService, err := reading.NewService(databases.Writer, databases.Reader)
	if err != nil {
		return nil, fmt.Errorf("configure reading: %w", err)
	}
	app := &application{
		databases: databases,
		scheduler: scheduler,
		logger:    logger,
	}
	app.handler, err = httpapi.NewRouter(httpapi.RouterOptions{
		Database: databases.Reader, Ready: app.ready.Load, Assets: assets, Logger: logger,
		TrustedProxies: cfg.TrustedProxies, MaxBodyBytes: cfg.MaxUploadBytes, BaseURL: cfg.BaseURL,
		Mounts: []httpapi.Mount{
			httpapi.AuthMount(authentication, logger),
			httpapi.CatalogMount(catalogService, authentication, logger),
			httpapi.ReadingMount(readingService, authentication, logger),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("configure HTTP router: %w", err)
	}
	app.ready.Store(true)
	return app, nil
}

func (a *application) close() error {
	a.ready.Store(false)
	if err := a.databases.Close(); err != nil {
		return fmt.Errorf("close application database: %w", err)
	}
	return nil
}

// Run initializes the application before opening the HTTP listener.
func Run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	return run(ctx, cfg, logger, net.Listen)
}

func run(ctx context.Context, cfg config.Config, logger *slog.Logger, listen func(string, string) (net.Listener, error)) (returnErr error) {
	app, err := newApplication(ctx, cfg, logger)
	if err != nil {
		return err
	}
	defer func() {
		if err := app.close(); err != nil {
			returnErr = errors.Join(returnErr, err)
		}
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	listener, err := listen("tcp", cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen on %q: %w", cfg.Listen, err)
	}
	return app.serve(ctx, listener)
}

func (a *application) serve(ctx context.Context, listener net.Listener) error {
	if err := a.scheduler.Start(ctx); err != nil {
		return errors.Join(fmt.Errorf("start scheduler: %w", err), listener.Close())
	}
	server := &http.Server{
		Handler:           a.handler,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.Serve(listener)
	}()
	a.logger.Info("HTTP server listening", "address", listener.Addr().String())

	var serveErr, stopErr error
	select {
	case serveErr = <-serveResult:
		a.ready.Store(false)
		if err := server.Close(); err != nil {
			stopErr = errors.Join(stopErr, fmt.Errorf("close HTTP server: %w", err))
		}
	case <-ctx.Done():
		a.ready.Store(false)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		if err := server.Shutdown(shutdownCtx); err != nil {
			stopErr = errors.Join(stopErr, fmt.Errorf("shut down HTTP server: %w", err))
			if closeErr := server.Close(); closeErr != nil {
				stopErr = errors.Join(stopErr, fmt.Errorf("force close HTTP server: %w", closeErr))
			}
		}
		cancel()
		serveErr = <-serveResult
	}
	stopCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	if err := a.scheduler.Stop(stopCtx); err != nil {
		stopErr = errors.Join(stopErr, err)
	}
	cancel()
	if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		stopErr = errors.Join(stopErr, fmt.Errorf("serve HTTP: %w", serveErr))
	}
	return stopErr
}
