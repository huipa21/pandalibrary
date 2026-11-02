package jobs

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"
)

func TestSchedulerCancellation(t *testing.T) {
	scheduler, err := NewScheduler(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	stopped := make(chan struct{})
	err = scheduler.Register("test", time.Millisecond, func(ctx context.Context) error {
		close(started)
		<-ctx.Done()
		close(stopped)
		return ctx.Err()
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("job did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := scheduler.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("job did not observe cancellation")
	}
	if err := scheduler.Register("late", time.Second, func(context.Context) error { return nil }); err == nil {
		t.Fatal("registration after start succeeded")
	}
}

func TestSchedulerValidationAndEmptyStop(t *testing.T) {
	if _, err := NewScheduler(nil); err == nil {
		t.Fatal("nil logger accepted")
	}
	scheduler, err := NewScheduler(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Register("", time.Second, func(context.Context) error { return nil }); err == nil {
		t.Fatal("empty job name accepted")
	}
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Start(context.Background()); err == nil {
		t.Fatal("second start succeeded")
	}
	if err := scheduler.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	canceledScheduler, err := NewScheduler(slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if err := canceledScheduler.Start(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("Start(canceled) = %v", err)
	}
}

func TestSchedulerStopTimeout(t *testing.T) {
	scheduler, err := NewScheduler(slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	if err := scheduler.Register("slow", time.Millisecond, func(context.Context) error {
		close(started)
		<-release
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := scheduler.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("job did not start")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := scheduler.Stop(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Stop() = %v, want deadline exceeded", err)
	}
	close(release)
	if err := scheduler.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
}
