package metadata

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestURLAndAddressPolicy(t *testing.T) {
	base, err := parseBase("openlibrary", nil)
	if err != nil {
		t.Fatal(err)
	}
	policy := networkPolicy{provider: "openlibrary", base: base, cover: true}
	for _, raw := range []string{
		"http://covers.openlibrary.org/a.jpg", "file:///a.jpg", "https://127.0.0.1/a.jpg",
		"https://covers.openlibrary.org.evil.test/a.jpg", "https://user@covers.openlibrary.org/a.jpg",
		"https://covers.openlibrary.org:8443/a.jpg", "//covers.openlibrary.org/a.jpg",
		"https://covers.openlibrary.org/a.jpg#fragment",
	} {
		u, err := url.Parse(raw)
		if err == nil && policy.validate(u) == nil {
			t.Errorf("unsafe cover URL accepted: %s", raw)
		}
	}
	for _, ip := range []string{
		"127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0",
		"100.64.0.1", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a00:1",
	} {
		if publicIP(net.ParseIP(ip)) {
			t.Errorf("unsafe IP accepted: %s", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "2606:4700:4700::1111"} {
		if !publicIP(net.ParseIP(ip)) {
			t.Errorf("public IP rejected: %s", ip)
		}
	}
	for _, raw := range []string{"http://evil.example", "https://neodb.social/path", "https://user:pass@neodb.social", "https://neodb.social#x"} {
		if _, err := parseBase("hardcover", &raw); !errors.Is(err, ErrInvalid) {
			t.Errorf("non-NeoDB override accepted: %q", raw)
		}
		for _, raw := range []string{"https://neodb.social:0", "https://neodb.social:65536"} {
			if _, err := parseBase("neodb", &raw); !errors.Is(err, ErrInvalid) {
				t.Errorf("invalid port accepted: %s", raw)
			}
		}
	}
	neo := "http://127.0.0.1:8080"
	neoBase, err := parseBase("neodb", &neo)
	if err != nil {
		t.Fatal(err)
	}
	neoPolicy := networkPolicy{provider: "neodb", base: neoBase, explicit: true, cover: true}
	if neoPolicy.validate(neoBase) != nil {
		t.Fatal("explicit private instance rejected")
	}
	otherPort, _ := url.Parse("http://127.0.0.1:8081/secret")
	if neoPolicy.validate(otherPort) == nil {
		t.Fatal("private exception escaped configured origin")
	}
}

func TestResolvedPrivateAddressesAndDNSPinning(t *testing.T) {
	base, _ := parseBase("openlibrary", nil)
	var dialed atomic.Bool
	policy := networkPolicy{
		provider: "openlibrary", base: base, cover: true,
		lookup: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}, {IP: net.ParseIP("127.0.0.1")}}, nil
		},
		dial: func(context.Context, string, string) (net.Conn, error) {
			dialed.Store(true)
			return nil, errors.New("must not dial private DNS answers")
		},
	}
	response, err := policy.client().Get("https://covers.openlibrary.org/a.jpg")
	if response != nil {
		response.Body.Close()
	}
	if err == nil || dialed.Load() {
		t.Fatalf("private DNS reached dial: %v", err)
	}
	policy.lookup = func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}
	policy.dial = func(_ context.Context, _, address string) (net.Conn, error) {
		dialed.Store(true)
		if address != "8.8.8.8:443" {
			t.Errorf("dialed unresolved hostname: %s", address)
		}
		return nil, errors.New("fixture connection refused")
	}
	_, _ = policy.client().Get("https://covers.openlibrary.org/a.jpg")
	if !dialed.Load() {
		t.Fatal("public resolved IP was not dialed")
	}
}

func TestNeoDBPrivateExceptionRequiresExactOrigin(t *testing.T) {
	rawBase := "http://neodb.social:443"
	base, err := parseBase("neodb", &rawBase)
	if err != nil {
		t.Fatal(err)
	}
	var dialed atomic.Bool
	policy := networkPolicy{
		provider: "neodb", base: base, explicit: true, cover: true,
		lookup: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		},
		dial: func(_ context.Context, _, address string) (net.Conn, error) {
			dialed.Store(true)
			if address != "127.0.0.1:443" {
				t.Errorf("unexpected dial address: %s", address)
			}
			return nil, errors.New("fixture connection refused")
		},
	}
	for _, test := range []struct {
		name     string
		target   string
		wantDial bool
	}{
		{"configured origin", "http://neodb.social:443/cover.jpg", true},
		{"different scheme", "https://neodb.social/cover.jpg", false},
		{"different scheme with explicit port", "https://neodb.social:443/cover.jpg", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			target, err := url.Parse(test.target)
			if err != nil || policy.validate(target) != nil {
				t.Fatalf("fixture target is not allowed: %s", test.target)
			}
			dialed.Store(false)
			response, err := policy.client().Get(test.target)
			if response != nil {
				response.Body.Close()
			}
			if err == nil || dialed.Load() != test.wantDial {
				t.Fatalf("private address dialed = %v, want %v (err=%v)", dialed.Load(), test.wantDial, err)
			}
		})
	}
}

func TestNeoDBPrivateExceptionDoesNotFollowSchemeChangingRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://neodb.social/cover.jpg", http.StatusFound)
	}))
	defer server.Close()
	rawBase := "http://neodb.social:443"
	base, err := parseBase("neodb", &rawBase)
	if err != nil {
		t.Fatal(err)
	}
	var dialed atomic.Int64
	policy := networkPolicy{
		provider: "neodb", base: base, explicit: true, cover: true,
		lookup: func(context.Context, string) ([]net.IPAddr, error) {
			return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
		},
		dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			dialed.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
		},
	}
	response, err := policy.client().Get(rawBase + "/cover.jpg")
	if response != nil {
		response.Body.Close()
	}
	if err == nil || dialed.Load() != 1 {
		t.Fatalf("scheme-changing redirect dialed %d times, want 1 (err=%v)", dialed.Load(), err)
	}
}

func TestRedirectsRevalidateHostsAndResolvedAddresses(t *testing.T) {
	for _, destination := range []string{
		"http://127.0.0.1/secret",
		"https://evil.example/secret",
		"https://books.googleusercontent.com/private",
	} {
		t.Run(destination, func(t *testing.T) {
			var requests atomic.Int64
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				http.Redirect(w, r, destination, http.StatusFound)
			}))
			defer server.Close()
			base, _ := parseBase("googlebooks", nil)
			policy := networkPolicy{
				provider: "googlebooks", base: base, cover: true,
				lookup: func(_ context.Context, host string) ([]net.IPAddr, error) {
					if host == "books.googleusercontent.com" {
						return []net.IPAddr{{IP: net.ParseIP("127.0.0.1")}}, nil
					}
					return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
				},
				dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
					return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
				},
			}
			client := policy.client()
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			client.Transport.(*policyTransport).transport.TLSClientConfig = &tls.Config{
				RootCAs: roots, ServerName: "127.0.0.1", MinVersion: tls.VersionTLS12,
			}
			response, err := client.Get("https://books.google.com/cover.jpg")
			if response != nil {
				response.Body.Close()
			}
			if err == nil || requests.Load() != 1 {
				t.Fatalf("unsafe redirect made request: count=%d err=%v", requests.Load(), err)
			}
		})
	}
}

func TestAPIClientDoesNotForwardCredentialsAcrossOrigins(t *testing.T) {
	var redirected atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		redirected.Store(true)
	}))
	defer other.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	p := &adapter{name: "neodb", base: base, token: "fixture-private-token",
		client: (networkPolicy{provider: "neodb", base: base, explicit: true}).client()}
	_, err := p.Search(context.Background(), Query{Title: "Test"})
	if err == nil || redirected.Load() || strings.Contains(err.Error(), p.token) {
		t.Fatalf("API redirect credentials policy: redirected=%v err=%v", redirected.Load(), err)
	}
}
