package jobs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

type periodicJob struct {
	name     string
	interval time.Duration
	run      func(context.Context) error
}

// Scheduler runs registered periodic jobs until its context is canceled.
type Scheduler struct {
	mu      sync.Mutex
	jobs    []periodicJob
	started bool
	cancel  context.CancelFunc
	done    chan struct{}
	logger  *slog.Logger
}

// NewScheduler creates a scheduler without starting background work.
func NewScheduler(logger *slog.Logger) (*Scheduler, error) {
	if logger == nil {
		return nil, errors.New("scheduler logger must not be nil")
	}
	return &Scheduler{logger: logger}, nil
}

// Register adds a job before the scheduler starts.
func (s *Scheduler) Register(name string, interval time.Duration, run func(context.Context) error) error {
	if name == "" || interval <= 0 || run == nil {
		return errors.New("periodic job requires a name, positive interval, and callback")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return errors.New("cannot register a job after the scheduler starts")
	}
	for _, job := range s.jobs {
		if job.name == name {
			return fmt.Errorf("periodic job %q is already registered", name)
		}
	}
	s.jobs = append(s.jobs, periodicJob{name: name, interval: interval, run: run})
	return nil
}

// Start starts the registered jobs, or no goroutines when there are none.
func (s *Scheduler) Start(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.started {
		return errors.New("scheduler already started")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.started = true
	ctx, s.cancel = context.WithCancel(ctx)
	s.done = make(chan struct{})
	if len(s.jobs) == 0 {
		close(s.done)
		return nil
	}
	var wg sync.WaitGroup
	for _, job := range s.jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s.runJob(ctx, job)
		}()
	}
	go func() {
		wg.Wait()
		close(s.done)
	}()
	return nil
}

func (s *Scheduler) runJob(ctx context.Context, job periodicJob) {
	ticker := time.NewTicker(job.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if ctx.Err() != nil {
				return
			}
			if err := job.run(ctx); err != nil && ctx.Err() == nil {
				s.logger.Error("periodic job failed", "job", job.name, "error", err)
			}
			if ctx.Err() != nil {
				return
			}
		}
	}
}

// Stop cancels jobs and waits for them, bounded by ctx.
func (s *Scheduler) Stop(ctx context.Context) error {
	s.mu.Lock()
	if !s.started {
		s.mu.Unlock()
		return nil
	}
	cancel, done := s.cancel, s.done
	s.mu.Unlock()
	cancel()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("stop scheduler: %w", ctx.Err())
	}
}
