package metadata

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var errUnsafeURL = errors.New("metadata destination is not allowed")

var providerOrigins = map[string]string{
	"openlibrary": "https://openlibrary.org",
	"googlebooks": "https://www.googleapis.com",
	"neodb":       "https://neodb.social",
	"hardcover":   "https://api.hardcover.app",
}

var coverHosts = map[string][]string{
	"openlibrary": {"covers.openlibrary.org"},
	"googlebooks": {"books.google.com", "books.googleusercontent.com"},
	"neodb":       {"neodb.social", "neodb-cdn.b0.upaiyun.com"},
	"hardcover":   {"assets.hardcover.app"},
}

type networkPolicy struct {
	provider string
	base     *url.URL
	explicit bool
	cover    bool
	lookup   func(context.Context, string) ([]net.IPAddr, error)
	dial     func(context.Context, string, string) (net.Conn, error)
}

type privateOriginKey struct{}

type policyTransport struct {
	policy    networkPolicy
	transport *http.Transport
}

func (t *policyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	private := req.URL != nil && t.policy.privateInstance(req.URL)
	ctx := context.WithValue(req.Context(), privateOriginKey{}, private)
	return t.transport.RoundTrip(req.WithContext(ctx))
}

func parseBase(provider string, base *string) (*url.URL, error) {
	raw, known := providerOrigins[provider]
	if !known {
		return nil, ErrInvalid
	}
	if base != nil {
		if provider != "neodb" {
			return nil, ErrInvalid
		}
		raw = strings.TrimSpace(*base)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || u.User != nil || u.RawQuery != "" ||
		u.Fragment != "" || u.Opaque != "" || (u.Path != "" && u.Path != "/") ||
		(u.Scheme != "https" && !(provider == "neodb" && base != nil && u.Scheme == "http")) {
		return nil, ErrInvalid
	}
	if strings.ContainsAny(u.Host, "\\\r\n\t%") || strings.HasSuffix(u.Host, ":") {
		return nil, ErrInvalid
	}
	if u.Port() != "" {
		port, err := strconv.Atoi(u.Port())
		if err != nil || port < 1 || port > 65535 {
			return nil, ErrInvalid
		}
	}
	u.Path = ""
	return u, nil
}

func (p networkPolicy) privateInstance(u *url.URL) bool {
	return p.provider == "neodb" && p.explicit && sameOrigin(u, p.base)
}

func sameOrigin(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host)
}

func (p networkPolicy) validate(u *url.URL) error {
	if u == nil || u.User != nil || u.Opaque != "" || u.Fragment != "" || u.Hostname() == "" ||
		strings.ContainsAny(u.Host, "\\\r\n\t%") {
		return errUnsafeURL
	}
	if p.privateInstance(u) {
		return nil
	}
	if u.Scheme != "https" || (u.Port() != "" && u.Port() != "443") {
		return errUnsafeURL
	}
	if !p.cover {
		if sameOrigin(u, p.base) {
			return nil
		}
		return errUnsafeURL
	}
	for _, host := range coverHosts[p.provider] {
		if strings.EqualFold(u.Hostname(), host) {
			return nil
		}
	}
	return errUnsafeURL
}

func publicIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	if !addr.IsGlobalUnicast() || addr.IsPrivate() || addr.IsLoopback() || addr.IsLinkLocalUnicast() {
		return false
	}
	for _, prefix := range []string{
		"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24",
		"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4",
		"2001::/23", "2001:db8::/32", "2002::/16", "64:ff9b::/96",
	} {
		if netip.MustParsePrefix(prefix).Contains(addr) {
			return false
		}
	}
	return true
}

func (p networkPolicy) client() *http.Client {
	lookup := p.lookup
	if lookup == nil {
		lookup = net.DefaultResolver.LookupIPAddr
	}
	dial := p.dial
	if dial == nil {
		dial = (&net.Dialer{Timeout: 4 * time.Second}).DialContext
	}
	transport := &http.Transport{
		Proxy: nil, TLSHandshakeTimeout: 4 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second, DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, errUnsafeURL
			}
			ips, err := lookup(ctx, host)
			if err != nil || len(ips) == 0 {
				return nil, errors.New("metadata destination resolution failed")
			}
			// DialContext receives only host and port; retain the request's scheme
			// so the private-instance exception cannot cross origins on redirects.
			privateOrigin, _ := ctx.Value(privateOriginKey{}).(bool)
			private := privateOrigin && p.provider == "neodb" && p.explicit &&
				strings.EqualFold(host, p.base.Hostname()) &&
				port == effectivePort(p.base)
			for _, ip := range ips {
				if !private && !publicIP(ip.IP) {
					return nil, errUnsafeURL
				}
			}
			// Dial the validated address, not the hostname, to prevent DNS rebinding.
			return dial(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
		},
	}
	return &http.Client{
		Transport: &policyTransport{policy: p, transport: transport}, Timeout: 8 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 3 {
				return errUnsafeURL
			}
			if !p.cover && !sameOrigin(req.URL, via[0].URL) {
				return errUnsafeURL
			}
			return p.validate(req.URL)
		},
	}
}

func effectivePort(u *url.URL) string {
	if port := u.Port(); port != "" {
		return port
	}
	if u.Scheme == "http" {
		return "80"
	}
	return "443"
}
