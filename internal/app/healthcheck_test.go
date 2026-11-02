package app

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestHealthcheckSuccessAndFailure(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusOK)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Errorf("healthcheck path = %q", r.URL.Path)
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer server.Close()
	address := server.Listener.Addr().String()
	if err := Healthcheck(context.Background(), address); err != nil {
		t.Fatal(err)
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		t.Fatal(err)
	}
	for _, listen := range []string{":" + port, net.JoinHostPort("0.0.0.0", port)} {
		if err := Healthcheck(context.Background(), listen); err != nil {
			t.Fatalf("wildcard healthcheck %q: %v", listen, err)
		}
	}
	status.Store(http.StatusServiceUnavailable)
	if err := Healthcheck(context.Background(), address); err == nil || !strings.Contains(err.Error(), "503") {
		t.Fatalf("503 healthcheck error = %v", err)
	}
	status.Store(http.StatusFound)
	if err := Healthcheck(context.Background(), address); err == nil || !strings.Contains(err.Error(), "302") {
		t.Fatalf("redirect healthcheck error = %v", err)
	}
	if err := Healthcheck(context.Background(), ":0"); err == nil {
		t.Fatal("healthcheck accepted port 0")
	}
	server.Close()
	if err := Healthcheck(context.Background(), address); err == nil {
		t.Fatal("healthcheck succeeded against a stopped server")
	}
}
