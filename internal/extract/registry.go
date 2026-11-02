package extract

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const DefaultExecutionTimeout = 10 * time.Second

type Registry struct {
	mu       sync.RWMutex
	handlers map[Format]Extractor
	timeout  time.Duration
}

func NewRegistry(timeout time.Duration) *Registry {
	if timeout <= 0 {
		timeout = DefaultExecutionTimeout
	}
	return &Registry{handlers: make(map[Format]Extractor), timeout: timeout}
}

func (r *Registry) Register(format Format, extractor Extractor) error {
	if r == nil || format == "" || extractor == nil {
		return fmt.Errorf("%w: format and extractor are required", ErrInvalidInput)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[format]; exists {
		return fmt.Errorf("%w: extractor for %s already registered", ErrInvalidInput, format)
	}
	r.handlers[format] = extractor
	return nil
}

func (r *Registry) Extract(ctx context.Context, input io.ReaderAt, size int64, filename string) (Metadata, error) {
	if r == nil || ctx == nil {
		return Metadata{}, fmt.Errorf("%w: registry and context are required", ErrInvalidInput)
	}
	if err := ctx.Err(); err != nil {
		return Metadata{}, err
	}
	format, err := Sniff(input, size)
	if err != nil {
		return Metadata{}, err
	}
	r.mu.RLock()
	extractor, ok := r.handlers[format]
	r.mu.RUnlock()
	if !ok {
		return Metadata{}, fmt.Errorf("%w: %s (%w)", ErrNotRegistered, format, ErrUnsupportedFormat)
	}

	executionContext, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	type result struct {
		metadata Metadata
		err      error
	}
	resultChannel := make(chan result, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				resultChannel <- result{err: fmt.Errorf("%w: %v", ErrExtractorPanic, recovered)}
			}
		}()
		metadata, err := extractor(executionContext, input, size, filename)
		resultChannel <- result{metadata: metadata, err: err}
	}()

	select {
	case result := <-resultChannel:
		if errors.Is(executionContext.Err(), context.DeadlineExceeded) {
			return Metadata{}, fmt.Errorf("%w: %v", ErrTimeout, executionContext.Err())
		}
		if result.err != nil {
			return Metadata{}, result.err
		}
		if err := executionContext.Err(); err != nil {
			return Metadata{}, err
		}
		return result.metadata, nil
	case <-executionContext.Done():
		if errors.Is(executionContext.Err(), context.DeadlineExceeded) {
			return Metadata{}, fmt.Errorf("%w: %v", ErrTimeout, executionContext.Err())
		}
		return Metadata{}, executionContext.Err()
	}
}
