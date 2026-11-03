package blobstore

import (
	"context"
	"errors"
	"testing"
)

func TestPublicationGuardWaitIsCancelable(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	err = store.WithPublicationLock(context.Background(), func() error {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		return store.WithPublicationLock(ctx, func() error {
			t.Fatal("canceled orphan removal acquired the publication guard")
			return nil
		})
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("publication guard ignored cancellation: %v", err)
	}
}
