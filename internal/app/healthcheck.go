package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"time"

	"pandalibrary/internal/config"
)

// Healthcheck probes the local server rather than the public base URL.
func Healthcheck(ctx context.Context, listen string) (returnErr error) {
	if err := config.ValidateListen(listen); err != nil {
		return err
	}
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return fmt.Errorf("split healthcheck listen address: %w", err)
	}
	if port == "0" {
		return errors.New("healthcheck cannot probe a listener configured with port 0")
	}
	if host == "" {
		host = "127.0.0.1"
	} else if address, err := netip.ParseAddr(host); err == nil && address.IsUnspecified() {
		if address.Is6() && !address.Is4In6() {
			host = "::1"
		} else {
			host = "127.0.0.1"
		}
	}
	target := (&url.URL{Scheme: "http", Host: net.JoinHostPort(host, port), Path: "/healthz"}).String()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return fmt.Errorf("create healthcheck request: %w", err)
	}
	client := &http.Client{
		Timeout:       3 * time.Second,
		Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("healthcheck request failed: %w", err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			returnErr = errors.Join(returnErr, fmt.Errorf("close healthcheck response: %w", err))
		}
	}()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("healthcheck returned HTTP %d", response.StatusCode)
	}
	return nil
}
