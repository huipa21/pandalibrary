package metadata

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	nethtml "golang.org/x/net/html"
)

const (
	maxResponseBytes = 2 << 20
	maxCandidates    = 10
	userAgent        = "PandaLibrary/1.0 (self-hosted ebook catalog; metadata lookup)"
	// Amazon and Goodreads serve bot challenges unless the request resembles a browser.
	browserUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
)

type providerError struct {
	code string
}

func (e *providerError) Error() string { return "metadata provider: " + e.code }

func failure(code string) error { return &providerError{code: code} }

type adapter struct {
	name   string
	base   *url.URL
	token  string
	client *http.Client
}

func newAdapter(name string, base *string, token string) (Provider, error) {
	u, err := parseBase(name, base)
	if err != nil {
		return nil, err
	}
	policy := networkPolicy{provider: name, base: u, explicit: base != nil}
	return &adapter{name: name, base: u, token: token, client: policy.client()}, nil
}

func (p *adapter) Name() string { return p.name }

func (p *adapter) browserHeaders(req *http.Request) {
	if p.name != "amazon" && p.name != "goodreads" {
		return
	}
	req.Header.Set("User-Agent", browserUserAgent)
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Sec-Ch-Ua", `"Google Chrome";v="137", "Chromium";v="137", "Not_A Brand";v="24"`)
	req.Header.Set("Sec-Ch-Ua-Mobile", "?0")
	req.Header.Set("Sec-Ch-Ua-Platform", `"macOS"`)
	if p.name == "amazon" {
		req.Header.Set("Accept", "text/html, application/json")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", p.base.Scheme+"://"+p.base.Host)
		req.Header.Set("Device-Memory", "8")
		req.Header.Set("Downlink", "10")
		req.Header.Set("Dpr", "2")
		req.Header.Set("Ect", "4g")
		req.Header.Set("Priority", "u=1, i")
		req.Header.Set("Rtt", "50")
		req.Header.Set("Sec-Fetch-Dest", "empty")
		req.Header.Set("Sec-Fetch-Mode", "cors")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Viewport-Width", "1170")
		req.Header.Set("X-Amz-Ammabot-Click-Attributes", "disable")
		req.Header.Set("X-Requested-With", "XMLHttpRequest")
		return
	}
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Sec-Fetch-Mode", "navigate")
	req.Header.Set("Sec-Fetch-Site", "none")
}

func (p *adapter) fetch(ctx context.Context, path string, values url.Values, body any, accept string) ([]byte, error) {
	if (p.name == "neodb" || p.name == "hardcover") && p.token == "" {
		return nil, failure("credentials_required")
	}
	u := *p.base
	u.Path = path
	if values == nil {
		values = make(url.Values)
	}
	if p.name == "googlebooks" && p.token != "" {
		values.Set("key", p.token)
	}
	u.RawQuery = values.Encode()
	method := http.MethodGet
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, failure("invalid_request")
		}
		reader = bytes.NewReader(data)
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return nil, failure("invalid_request")
	}
	req.Header.Set("Accept", accept)
	req.Header.Set("User-Agent", userAgent)
	p.browserHeaders(req)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if p.token != "" && (p.name == "neodb" || p.name == "hardcover") {
		req.Header.Set("Authorization", "Bearer "+strings.TrimPrefix(p.token, "Bearer "))
	}
	res, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, failure("network_error")
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, ErrNotFound
	case http.StatusTooManyRequests:
		return nil, failure("rate_limited")
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, failure("authentication_failed")
	default:
		return nil, failure("upstream_error")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return nil, failure("response_read_failed")
	}
	if len(data) > maxResponseBytes {
		return nil, failure("response_too_large")
	}
	return data, nil
}

func (p *adapter) request(ctx context.Context, path string, values url.Values, body any, dest any) error {
	data, err := p.fetch(ctx, path, values, body, "application/json")
	if err != nil {
		return err
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) || json.Unmarshal(data, dest) != nil {
		return failure("invalid_response")
	}
	return nil
}

func (p *adapter) Search(ctx context.Context, q Query) ([]Candidate, error) {
	switch p.name {
	case "openlibrary":
		return p.openLibrary(ctx, q, "")
	case "googlebooks":
		return p.googleBooks(ctx, q, "")
	case "neodb":
		return p.neoDB(ctx, q, "")
	case "hardcover":
		return p.hardcover(ctx, q, "")
	case "crossref":
		return p.crossref(ctx, q, "")
	case "openbd":
		return p.openBD(ctx, q, "")
	case "douban":
		return p.douban(ctx, q, "")
	case "goodreads":
		return p.goodreads(ctx, q, "")
	case "amazon":
		return p.amazon(ctx, q, "")
	default:
		return nil, ErrInvalid
	}
}

var safeReference = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var openReference = regexp.MustCompile(`^/(works|books)/OL[0-9]+[WM]$`)
var crossrefReference = regexp.MustCompile(`^10\.[0-9]{4,9}/[!-~]{1,200}$`)

func validProviderReference(name, ref string) bool {
	switch name {
	case "openlibrary":
		return openReference.MatchString(ref)
	case "crossref":
		return crossrefReference.MatchString(ref)
	default:
		return safeReference.MatchString(ref)
	}
}

func (p *adapter) Get(ctx context.Context, ref string) (*Candidate, error) {
	if !validProviderReference(p.name, ref) {
		return nil, ErrInvalid
	}
	var result []Candidate
	var err error
	switch p.name {
	case "openlibrary":
		result, err = p.openLibrary(ctx, Query{}, ref)
	case "googlebooks":
		result, err = p.googleBooks(ctx, Query{}, ref)
	case "neodb":
		result, err = p.neoDB(ctx, Query{}, ref)
	case "hardcover":
		result, err = p.hardcover(ctx, Query{}, ref)
	case "crossref":
		result, err = p.crossref(ctx, Query{}, ref)
	case "openbd":
		result, err = p.openBD(ctx, Query{}, ref)
	case "douban":
		result, err = p.douban(ctx, Query{}, ref)
	case "goodreads":
		result, err = p.goodreads(ctx, Query{}, ref)
	case "amazon":
		result, err = p.amazon(ctx, Query{}, ref)
	default:
		return nil, ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	for _, candidate := range result {
		if candidate.Reference == ref {
			return &candidate, nil
		}
	}
	return nil, ErrNotFound
}

func text(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func people(names []string, role string) []Person {
	result := make([]Person, 0, len(names))
	for _, name := range unique(names) {
		result = append(result, Person{Name: name, Role: role})
	}
	return result
}

func unique(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value != "" && !seen[key] {
			result = append(result, value)
			seen[key] = true
		}
	}
	return result
}

func isbnIdentifiers(values []string) []Identifier {
	result := make([]Identifier, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(value))
		scheme := ""
		if len(value) == 10 {
			scheme = "isbn10"
		} else if len(value) == 13 {
			scheme = "isbn13"
		}
		if scheme != "" && !seen[value] {
			result = append(result, Identifier{Scheme: scheme, Value: value})
			seen[value] = true
		}
	}
	return result
}

func date(value string) *string {
	for _, layout := range []string{"2006-01-02", "2006-1-2", "2006-01", "2006-1", "200601", "2006", "January 2, 2006", "Jan 2, 2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			switch layout {
			case "2006":
				return text(parsed.Format("2006"))
			case "2006-01", "2006-1", "200601":
				return text(parsed.Format("2006-01"))
			default:
				return text(parsed.Format("2006-01-02"))
			}
		}
	}
	return nil
}

func pages(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	return &value
}

func finish(name string, candidates []Candidate) ([]Candidate, error) {
	if len(candidates) > maxCandidates {
		candidates = candidates[:maxCandidates]
	}
	for i := range candidates {
		c := &candidates[i]
		c.Provider = name
		c.Title = strings.TrimSpace(c.Title)
		if c.Title == "" || c.Reference == "" {
			return nil, failure("invalid_response")
		}
		if c.Authors == nil {
			c.Authors = []Person{}
		}
		c.Tags = unique(c.Tags)
		c.Genres = unique(c.Genres)
		c.Moods = unique(c.Moods)
		if scheme := providerIdentifierScheme(name); scheme != "" {
			c.Identifiers = append(c.Identifiers, Identifier{Scheme: scheme, Value: c.Reference})
		}
		if c.CoverURL != nil && strings.HasPrefix(*c.CoverURL, "http://") && name != "neodb" {
			c.CoverURL = text("https://" + strings.TrimPrefix(*c.CoverURL, "http://"))
		}
	}
	if candidates == nil {
		candidates = []Candidate{}
	}
	return candidates, nil
}

// providerIdentifierScheme maps provider references to catalog identifier schemes.
// OpenBD references are ISBNs and are already present in the candidate identifiers.
func providerIdentifierScheme(name string) string {
	switch name {
	case "crossref":
		return "doi"
	case "openbd":
		return ""
	case "amazon":
		return "asin"
	default:
		return name
	}
}

type crossrefPerson struct {
	Given   string `json:"given"`
	Family  string `json:"family"`
	Name    string `json:"name"`
	Literal string `json:"literal"`
}

func (p crossrefPerson) display() string {
	if value := strings.TrimSpace(p.Name); value != "" {
		return value
	}
	if value := strings.TrimSpace(p.Literal); value != "" {
		return value
	}
	return strings.TrimSpace(strings.Join([]string{p.Given, p.Family}, " "))
}

type crossrefDate struct {
	DateParts [][]int `json:"date-parts"`
}

type crossrefWork struct {
	Type            string           `json:"type"`
	Title           []string         `json:"title"`
	Subtitle        []string         `json:"subtitle"`
	Author          []crossrefPerson `json:"author"`
	Editor          []crossrefPerson `json:"editor"`
	Translator      []crossrefPerson `json:"translator"`
	Publisher       string           `json:"publisher"`
	Issued          crossrefDate     `json:"issued"`
	PublishedPrint  crossrefDate     `json:"published-print"`
	PublishedOnline crossrefDate     `json:"published-online"`
	Language        string           `json:"language"`
	ISBN            []string         `json:"ISBN"`
	DOI             string           `json:"DOI"`
	Subject         []string         `json:"subject"`
}

var crossrefBookTypes = map[string]bool{
	"book": true, "monograph": true, "edited-book": true, "reference-book": true,
}

func crossrefPeople(values []crossrefPerson, role string) []Person {
	names := make([]string, 0, len(values))
	for _, value := range values {
		if name := value.display(); name != "" {
			names = append(names, name)
		}
	}
	return people(names, role)
}

func crossrefDateValue(value crossrefDate) string {
	if len(value.DateParts) == 0 || len(value.DateParts[0]) == 0 {
		return ""
	}
	parts := value.DateParts[0]
	year := parts[0]
	if year < 1 {
		return ""
	}
	result := fmt.Sprintf("%04d", year)
	if len(parts) > 1 && parts[1] >= 1 && parts[1] <= 12 {
		result += fmt.Sprintf("-%02d", parts[1])
		if len(parts) > 2 && parts[2] >= 1 && parts[2] <= 31 {
			result += fmt.Sprintf("-%02d", parts[2])
		}
	}
	if parsed := date(result); parsed != nil {
		return *parsed
	}
	return ""
}

func crossrefPublished(work crossrefWork) *string {
	for _, value := range []crossrefDate{work.PublishedPrint, work.PublishedOnline, work.Issued} {
		if result := crossrefDateValue(value); result != "" {
			return text(result)
		}
	}
	return nil
}

func (p *adapter) crossrefCandidates(works []crossrefWork) ([]Candidate, error) {
	result := []Candidate{}
	for _, work := range works {
		if work.Type != "" && !crossrefBookTypes[work.Type] {
			continue
		}
		if work.DOI == "" || len(work.Title) == 0 || strings.TrimSpace(work.Title[0]) == "" {
			continue
		}
		c := Candidate{
			Reference: work.DOI, Title: work.Title[0], Subtitle: text(first(work.Subtitle)),
			Publisher: text(work.Publisher), PublishedDate: crossrefPublished(work),
			Language: text(work.Language), Tags: unique(work.Subject),
		}
		c.Authors = append(c.Authors, crossrefPeople(work.Author, "author")...)
		c.Authors = append(c.Authors, crossrefPeople(work.Editor, "editor")...)
		c.Authors = append(c.Authors, crossrefPeople(work.Translator, "translator")...)
		c.Identifiers = isbnIdentifiers(work.ISBN)
		result = append(result, c)
	}
	return finish(p.name, result)
}

func (p *adapter) crossref(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	if ref != "" {
		var response struct {
			Message crossrefWork `json:"message"`
		}
		if err := p.request(ctx, "/works/"+ref, nil, nil, &response); err != nil {
			return nil, err
		}
		if response.Message.DOI == "" {
			return nil, failure("invalid_response")
		}
		return p.crossrefCandidates([]crossrefWork{response.Message})
	}
	values := url.Values{"rows": {"10"}}
	if q.ISBN != "" {
		values.Set("filter", "isbn:"+q.ISBN)
	} else {
		query := strings.TrimSpace(strings.Join([]string{q.Title, q.Author, q.Language}, " "))
		if query == "" {
			return []Candidate{}, nil
		}
		values.Set("query.bibliographic", query)
	}
	var response struct {
		Message struct {
			Total *int64         `json:"total-results"`
			Items []crossrefWork `json:"items"`
		} `json:"message"`
	}
	if err := p.request(ctx, "/works", values, nil, &response); err != nil {
		return nil, err
	}
	if response.Message.Total == nil && response.Message.Items == nil {
		return nil, failure("invalid_response")
	}
	return p.crossrefCandidates(response.Message.Items)
}

type openBDBook struct {
	Summary struct {
		ISBN      string `json:"isbn"`
		Title     string `json:"title"`
		Series    string `json:"series"`
		Publisher string `json:"publisher"`
		Pubdate   string `json:"pubdate"`
		Cover     string `json:"cover"`
		Author    string `json:"author"`
	} `json:"summary"`
	Onix struct {
		DescriptiveDetail struct {
			Contributor []struct {
				PersonName struct {
					Content string `json:"content"`
				} `json:"PersonName"`
			} `json:"Contributor"`
		} `json:"DescriptiveDetail"`
	} `json:"onix"`
}

func (p *adapter) openBD(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	isbn := ref
	if isbn == "" {
		isbn = q.ISBN
	}
	if isbn == "" {
		return []Candidate{}, nil
	}
	var books []*openBDBook
	if err := p.request(ctx, "/v1/get", url.Values{"isbn": {isbn}}, nil, &books); err != nil {
		return nil, err
	}
	result := []Candidate{}
	for _, book := range books {
		if book == nil {
			continue
		}
		summary := book.Summary
		title := strings.TrimSpace(summary.Title)
		if title == "" {
			continue
		}
		reference := normalizeISBN(summary.ISBN)
		if reference == "" {
			reference = normalizeISBN(isbn)
		}
		c := Candidate{
			Reference: reference, Title: title, Publisher: text(summary.Publisher),
			PublishedDate: date(summary.Pubdate), CoverURL: text(summary.Cover),
			Identifiers: isbnIdentifiers([]string{summary.ISBN, isbn}),
		}
		for _, contributor := range book.Onix.DescriptiveDetail.Contributor {
			if name := strings.TrimSpace(contributor.PersonName.Content); name != "" {
				c.Authors = append(c.Authors, Person{Name: name, Role: "author"})
			}
		}
		if len(c.Authors) == 0 {
			c.Authors = people([]string{summary.Author}, "author")
		}
		if name := strings.TrimSpace(summary.Series); name != "" {
			c.Series = &Series{Name: name}
		}
		result = append(result, c)
	}
	return finish(p.name, result)
}

type doubanLD struct {
	Type   string          `json:"@type"`
	Name   string          `json:"name"`
	ISBN   string          `json:"isbn"`
	URL    string          `json:"url"`
	SameAs string          `json:"sameAs"`
	Author json.RawMessage `json:"author"`
}

var doubanSubject = regexp.MustCompile(`(?i)(?:book|m)\.douban\.com/(?:book/)?subject/([0-9]{1,20})/?`)

func doubanTitle(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimSuffix(value, " - 图书")
	return strings.TrimSpace(value)
}

func doubanAuthors(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var list []struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &list) == nil {
		result := make([]string, 0, len(list))
		for _, item := range list {
			if name := strings.TrimSpace(item.Name); name != "" {
				result = append(result, name)
			}
		}
		return result
	}
	var one struct {
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &one) == nil && strings.TrimSpace(one.Name) != "" {
		return []string{strings.TrimSpace(one.Name)}
	}
	var value string
	if json.Unmarshal(raw, &value) == nil && strings.TrimSpace(value) != "" {
		return []string{strings.TrimSpace(value)}
	}
	return nil
}

func htmlAttr(node *nethtml.Node, key string) string {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, key) {
			return attr.Val
		}
	}
	return ""
}

func htmlClass(node *nethtml.Node, class string) bool {
	for _, value := range strings.Fields(htmlAttr(node, "class")) {
		if value == class {
			return true
		}
	}
	return false
}

func htmlFind(node *nethtml.Node, match func(*nethtml.Node) bool) *nethtml.Node {
	if node == nil {
		return nil
	}
	if match(node) {
		return node
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if found := htmlFind(child, match); found != nil {
			return found
		}
	}
	return nil
}

func htmlText(node *nethtml.Node) string {
	if node == nil {
		return ""
	}
	var builder strings.Builder
	var walk func(*nethtml.Node)
	walk = func(current *nethtml.Node) {
		if current.Type == nethtml.TextNode {
			builder.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return strings.Join(strings.Fields(builder.String()), " ")
}

func htmlLines(node *nethtml.Node) []string {
	if node == nil {
		return nil
	}
	var lines []string
	var builder strings.Builder
	flush := func() {
		if value := strings.TrimSpace(builder.String()); value != "" {
			lines = append(lines, value)
		}
		builder.Reset()
	}
	var walk func(*nethtml.Node)
	walk = func(current *nethtml.Node) {
		if current.Type == nethtml.ElementNode && current.Data == "br" {
			flush()
			return
		}
		if current.Type == nethtml.TextNode {
			builder.WriteString(current.Data)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	flush()
	return lines
}

func leadingInt(value string) int64 {
	value = strings.TrimSpace(value)
	end := 0
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	if end == 0 {
		return 0
	}
	number, _ := strconv.ParseInt(value[:end], 10, 64)
	return number
}

func splitNames(value string) []string {
	return unique(strings.FieldsFunc(value, func(r rune) bool { return r == '/' || r == '、' }))
}

func parseDoubanSubject(data []byte, fallbackISBN string) (Candidate, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return Candidate{}, failure("invalid_response")
	}
	meta := map[string]string{}
	var ld doubanLD
	_ = htmlFind(doc, func(node *nethtml.Node) bool {
		if node.Type != nethtml.ElementNode {
			return false
		}
		switch node.Data {
		case "meta":
			key := strings.ToLower(htmlAttr(node, "property"))
			if key == "" {
				key = strings.ToLower(htmlAttr(node, "name"))
			}
			if key != "" {
				meta[key] = htmlAttr(node, "content")
			}
			if itemprop := strings.ToLower(htmlAttr(node, "itemprop")); itemprop != "" {
				meta["itemprop:"+itemprop] = htmlAttr(node, "content")
			}
		case "script":
			if strings.EqualFold(htmlAttr(node, "type"), "application/ld+json") && ld.Name == "" {
				_ = json.Unmarshal([]byte(htmlText(node)), &ld)
			}
		}
		return false
	})
	reference := ""
	for _, raw := range []string{ld.URL, ld.SameAs, meta["og:url"]} {
		if match := doubanSubject.FindStringSubmatch(raw); match != nil {
			reference = match[1]
			break
		}
	}
	if reference == "" {
		page := htmlText(doc)
		if strings.Contains(page, "条目不存在") || strings.Contains(page, "页面不存在") {
			return Candidate{}, ErrNotFound
		}
		return Candidate{}, failure("invalid_response")
	}
	title := doubanTitle(ld.Name)
	if node := htmlFind(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && htmlClass(node, "sub-title")
	}); node != nil {
		title = doubanTitle(htmlText(node))
	}
	if title == "" {
		title = doubanTitle(meta["og:title"])
	}
	if title == "" {
		return Candidate{}, failure("invalid_response")
	}
	info := map[string]string{}
	var authors, translators []string
	if node := htmlFind(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && htmlAttr(node, "id") == "info"
	}); node != nil {
		for _, line := range htmlLines(node) {
			label, value, ok := strings.Cut(line, ":")
			if !ok {
				label, value, ok = strings.Cut(line, "：")
			}
			if !ok {
				continue
			}
			label = strings.TrimSpace(label)
			value = strings.TrimSpace(value)
			switch label {
			case "作者":
				authors = append(authors, splitNames(value)...)
			case "译者":
				translators = append(translators, splitNames(value)...)
			default:
				info[label] = value
			}
		}
	}
	if node := htmlFind(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && htmlClass(node, "sub-meta")
	}); node != nil {
		parts := []string{}
		for _, part := range strings.Split(htmlText(node), "/") {
			if part = strings.TrimSpace(part); part != "" {
				parts = append(parts, part)
			}
		}
		if len(parts) > 0 && strings.HasSuffix(parts[len(parts)-1], "出版") {
			info["出版年"] = strings.TrimSpace(strings.TrimSuffix(parts[len(parts)-1], "出版"))
			parts = parts[:len(parts)-1]
		}
		if len(parts) > 1 {
			info["出版社"] = parts[len(parts)-1]
			parts = parts[:len(parts)-1]
		}
		authors = append(authors, parts...)
	}
	authors = append(authors, doubanAuthors(ld.Author)...)
	c := Candidate{
		Reference: reference, Title: title, Subtitle: text(info["副标题"]),
		Authors:     append(people(authors, "author"), people(translators, "translator")...),
		Description: text(meta["og:description"]), Publisher: text(info["出版社"]),
		PublishedDate: date(info["出版年"]), CoverURL: text(meta["og:image"]),
	}
	if count := leadingInt(info["页数"]); count > 0 {
		c.PageCount = pages(count)
	}
	if series := strings.TrimSpace(info["丛书"]); series != "" {
		c.Series = &Series{Name: series}
	}
	isbn := strings.TrimSpace(ld.ISBN)
	if isbn == "" {
		isbn = strings.TrimSpace(info["ISBN"])
	}
	if isbn == "" {
		isbn = fallbackISBN
	}
	c.Identifiers = isbnIdentifiers([]string{isbn})
	if node := htmlFind(doc, func(node *nethtml.Node) bool { return htmlClass(node, "rating_num") }); node != nil {
		if value, err := strconv.ParseFloat(htmlText(node), 64); err == nil {
			count := int64(0)
			if votes := htmlFind(doc, func(node *nethtml.Node) bool { return htmlClass(node, "rating_people") }); votes != nil {
				count = leadingInt(htmlText(votes))
			}
			c.Rating, c.RatingCount = rating(&value, 10, &count)
		}
	} else if value, err := strconv.ParseFloat(meta["itemprop:ratingvalue"], 64); err == nil {
		count := leadingInt(meta["itemprop:reviewcount"])
		c.Rating, c.RatingCount = rating(&value, 10, &count)
	}
	return c, nil
}

func parseDoubanSearch(data []byte) ([]string, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return nil, failure("invalid_response")
	}
	seen := map[string]bool{}
	result := []string{}
	add := func(raw string) {
		if match := doubanSubject.FindStringSubmatch(raw); match != nil && !seen[match[1]] {
			seen[match[1]] = true
			result = append(result, match[1])
		}
	}
	var walk func(*nethtml.Node)
	walk = func(node *nethtml.Node) {
		if node.Type == nethtml.ElementNode && node.Data == "a" && htmlClass(node, "nbg") {
			href := htmlAttr(node, "href")
			if parsed, err := url.Parse(href); err == nil {
				if target := parsed.Query().Get("url"); target != "" {
					href = target
				}
			}
			add(href)
		}
		if node.Type == nethtml.ElementNode && node.Data == "script" {
			text := htmlText(node)
			if index := strings.Index(text, "window.__DATA__"); index >= 0 {
				payload := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(text[index+len("window.__DATA__"):]), "="))
				var data struct {
					Items []struct {
						ID  int64  `json:"id"`
						URL string `json:"url"`
					} `json:"items"`
				}
				if json.NewDecoder(strings.NewReader(payload)).Decode(&data) == nil {
					for _, item := range data.Items {
						if item.ID > 0 {
							add("https://book.douban.com/subject/" + strconv.FormatInt(item.ID, 10) + "/")
						} else {
							add(item.URL)
						}
					}
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(doc)
	return result, nil
}

func (p *adapter) doubanSubject(ctx context.Context, reference string) (Candidate, error) {
	data, err := p.fetch(ctx, "/subject/"+reference+"/", nil, nil, "text/html")
	if err != nil {
		return Candidate{}, err
	}
	return parseDoubanSubject(data, "")
}

func (p *adapter) douban(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	if ref != "" {
		candidate, err := p.doubanSubject(ctx, ref)
		if err != nil {
			return nil, err
		}
		return finish(p.name, []Candidate{candidate})
	}
	if q.ISBN != "" {
		data, err := p.fetch(ctx, "/isbn/"+q.ISBN+"/", nil, nil, "text/html")
		if err != nil {
			return nil, err
		}
		candidate, err := parseDoubanSubject(data, q.ISBN)
		if err != nil {
			return nil, err
		}
		return finish(p.name, []Candidate{candidate})
	}
	if strings.TrimSpace(q.Title) == "" {
		return []Candidate{}, nil
	}
	query := strings.TrimSpace(strings.Join([]string{q.Title, q.Author}, " "))
	data, err := p.fetch(ctx, "/subject_search", url.Values{"search_text": {query}, "cat": {"1001"}}, nil, "text/html")
	if err != nil {
		return nil, err
	}
	ids, err := parseDoubanSearch(data)
	if err != nil {
		return nil, err
	}
	result := []Candidate{}
	for index, id := range ids {
		if index >= 3 {
			break
		}
		candidate, err := p.doubanSubject(ctx, id)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		result = append(result, candidate)
	}
	return finish(p.name, result)
}

type goodreadsAutocompleteItem struct {
	BookID        json.RawMessage `json:"bookId"`
	BookURL       string          `json:"bookUrl"`
	Title         string          `json:"title"`
	BookTitleBare string          `json:"bookTitleBare"`
	Author        json.RawMessage `json:"author"`
	ImageURL      string          `json:"imageUrl"`
	Description   json.RawMessage `json:"description"`
	AvgRating     json.RawMessage `json:"avgRating"`
	RatingsCount  json.RawMessage `json:"ratingsCount"`
	NumPages      json.RawMessage `json:"numPages"`
}

type goodreadsLD struct {
	Type            string          `json:"@type"`
	Name            string          `json:"name"`
	URL             string          `json:"url"`
	Author          json.RawMessage `json:"author"`
	ISBN            string          `json:"isbn"`
	NumberOfPages   json.RawMessage `json:"numberOfPages"`
	Publisher       string          `json:"publisher"`
	DatePublished   string          `json:"datePublished"`
	Image           json.RawMessage `json:"image"`
	Description     json.RawMessage `json:"description"`
	InLanguage      json.RawMessage `json:"inLanguage"`
	AggregateRating struct {
		RatingValue json.RawMessage `json:"ratingValue"`
		RatingCount json.RawMessage `json:"ratingCount"`
	} `json:"aggregateRating"`
}

var (
	goodreadsIDPattern  = regexp.MustCompile(`(?:^|/)([0-9]{1,20})(?:[^0-9]|$)`)
	goodreadsCoverSize  = regexp.MustCompile(`\._S[XY][0-9]+_\.`)
	amazonReferenceText = regexp.MustCompile(`/(?:dp|gp/product)/([A-Za-z0-9]{10})(?:[/?]|$)`)
	amazonRatingText    = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)\s+out of 5`)
)

func htmlPlain(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	doc, err := nethtml.Parse(strings.NewReader(value))
	if err != nil {
		return value
	}
	return strings.TrimSpace(htmlText(doc))
}

func htmlCollect(node *nethtml.Node, match func(*nethtml.Node) bool) []*nethtml.Node {
	result := []*nethtml.Node{}
	var walk func(*nethtml.Node)
	walk = func(current *nethtml.Node) {
		if current == nil {
			return
		}
		if current.Type == nethtml.ElementNode && match(current) {
			result = append(result, current)
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return result
}

func htmlByID(node *nethtml.Node, id string) *nethtml.Node {
	return htmlFind(node, func(current *nethtml.Node) bool {
		return current.Type == nethtml.ElementNode && htmlAttr(current, "id") == id
	})
}

func htmlByClass(node *nethtml.Node, class string) *nethtml.Node {
	return htmlFind(node, func(current *nethtml.Node) bool {
		return current.Type == nethtml.ElementNode && htmlClass(current, class)
	})
}

func jsonScalar(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return strings.TrimSpace(value)
	}
	var number json.Number
	if json.Unmarshal(raw, &number) == nil {
		return number.String()
	}
	return ""
}

func jsonNumber(raw json.RawMessage) (float64, bool) {
	value := strings.ReplaceAll(jsonScalar(raw), ",", "")
	if value == "" {
		return 0, false
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	return number, err == nil
}

func jsonText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return strings.TrimSpace(htmlPlain(value))
	}
	var object struct {
		HTML string `json:"html"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &object) == nil {
		if object.HTML != "" {
			return strings.TrimSpace(htmlPlain(object.HTML))
		}
		return strings.TrimSpace(object.Text)
	}
	return ""
}

func jsonURL(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) == nil {
		return strings.TrimSpace(value)
	}
	var object struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(raw, &object) == nil {
		return strings.TrimSpace(object.URL)
	}
	return ""
}

func splitBookTitle(value string) (string, string) {
	value = strings.TrimSpace(value)
	title, subtitle, found := strings.Cut(value, ":")
	if found && strings.TrimSpace(title) != "" {
		return strings.TrimSpace(title), strings.TrimSpace(subtitle)
	}
	return value, ""
}

func goodreadsReference(values ...string) string {
	for _, value := range values {
		if match := goodreadsIDPattern.FindStringSubmatch(strings.TrimSpace(value)); match != nil {
			return match[1]
		}
	}
	return ""
}

func goodreadsCover(value string) string {
	return goodreadsCoverSize.ReplaceAllString(strings.TrimSpace(value), ".")
}

func goodreadsCandidate(item goodreadsAutocompleteItem) Candidate {
	title, subtitle := splitBookTitle(item.BookTitleBare)
	if title == "" {
		title, subtitle = splitBookTitle(item.Title)
	}
	c := Candidate{
		Reference: goodreadsReference(jsonScalar(item.BookID), item.BookURL), Title: title, Subtitle: text(subtitle),
		Authors: people(doubanAuthors(item.Author), "author"), Description: text(jsonText(item.Description)),
		CoverURL: text(goodreadsCover(item.ImageURL)), Tags: []string{}, Genres: []string{}, Moods: []string{}, Identifiers: []Identifier{},
	}
	if pageCount, ok := jsonNumber(item.NumPages); ok && pageCount > 0 {
		c.PageCount = pages(int64(pageCount))
	}
	if value, ok := jsonNumber(item.AvgRating); ok {
		countValue, _ := jsonNumber(item.RatingsCount)
		count := int64(countValue)
		c.Rating, c.RatingCount = rating(&value, 5, &count)
	}
	return c
}

func parseGoodreadsAutocomplete(data []byte) ([]Candidate, error) {
	var items []goodreadsAutocompleteItem
	if json.Unmarshal(data, &items) != nil {
		return nil, failure("invalid_response")
	}
	result := []Candidate{}
	for _, item := range items {
		candidate := goodreadsCandidate(item)
		if candidate.Reference != "" && strings.TrimSpace(candidate.Title) != "" {
			result = append(result, candidate)
		}
	}
	return result, nil
}

func parseGoodreadsPage(data []byte, fallbackRef, fallbackISBN string) (Candidate, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return Candidate{}, failure("invalid_response")
	}
	var ld goodreadsLD
	meta := map[string]string{}
	canonical := ""
	_ = htmlFind(doc, func(node *nethtml.Node) bool {
		if node.Type != nethtml.ElementNode {
			return false
		}
		switch node.Data {
		case "meta":
			key := strings.ToLower(htmlAttr(node, "property"))
			if key == "" {
				key = strings.ToLower(htmlAttr(node, "name"))
			}
			if key != "" {
				meta[key] = htmlAttr(node, "content")
			}
		case "link":
			if strings.EqualFold(htmlAttr(node, "rel"), "canonical") {
				canonical = htmlAttr(node, "href")
			}
		case "script":
			if strings.EqualFold(htmlAttr(node, "type"), "application/ld+json") && ld.Name == "" {
				_ = json.Unmarshal([]byte(htmlText(node)), &ld)
			}
		}
		return false
	})
	reference := goodreadsReference(fallbackRef, canonical, ld.URL, meta["og:url"])
	if reference == "" {
		return Candidate{}, failure("invalid_response")
	}
	title, subtitle := splitBookTitle(ld.Name)
	if title == "" {
		title, subtitle = splitBookTitle(meta["og:title"])
	}
	if title == "" {
		if node := htmlFind(doc, func(node *nethtml.Node) bool {
			return node.Type == nethtml.ElementNode && node.Data == "h1" && htmlClass(node, "bookTitle")
		}); node != nil {
			title, subtitle = splitBookTitle(htmlText(node))
		}
	}
	if title == "" {
		return Candidate{}, failure("invalid_response")
	}
	authors := doubanAuthors(ld.Author)
	if len(authors) == 0 {
		for _, node := range htmlCollect(doc, func(node *nethtml.Node) bool {
			return node.Type == nethtml.ElementNode && node.Data == "a" && htmlClass(node, "authorName")
		}) {
			authors = append(authors, htmlText(node))
		}
	}
	cover := jsonURL(ld.Image)
	if cover == "" {
		cover = meta["og:image"]
	}
	description := jsonText(ld.Description)
	if description == "" {
		description = htmlPlain(meta["og:description"])
	}
	c := Candidate{
		Reference: reference, Title: title, Subtitle: text(subtitle), Authors: people(authors, "author"),
		Description: text(description), Publisher: text(ld.Publisher), PublishedDate: date(ld.DatePublished),
		Language: text(jsonScalar(ld.InLanguage)), CoverURL: text(goodreadsCover(cover)),
		Tags: []string{}, Genres: []string{}, Moods: []string{}, Identifiers: isbnIdentifiers([]string{ld.ISBN, fallbackISBN}),
	}
	if value, ok := jsonNumber(ld.NumberOfPages); ok && value > 0 {
		c.PageCount = pages(int64(value))
	}
	if value, ok := jsonNumber(ld.AggregateRating.RatingValue); ok {
		countValue, _ := jsonNumber(ld.AggregateRating.RatingCount)
		count := int64(countValue)
		c.Rating, c.RatingCount = rating(&value, 5, &count)
	}
	return c, nil
}

func parseGoodreadsSearch(data []byte) ([]Candidate, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return nil, failure("invalid_response")
	}
	result := []Candidate{}
	seen := map[string]bool{}
	for _, anchor := range htmlCollect(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "a" && htmlClass(node, "bookTitle")
	}) {
		reference := goodreadsReference(htmlAttr(anchor, "href"))
		title := htmlText(anchor)
		if reference == "" || title == "" || seen[reference] {
			continue
		}
		seen[reference] = true
		row := anchor.Parent
		for depth := 0; row != nil && depth < 5 && row.Data != "tr"; depth++ {
			row = row.Parent
		}
		authors := []string{}
		cover := ""
		if row != nil {
			for _, author := range htmlCollect(row, func(node *nethtml.Node) bool {
				return node.Type == nethtml.ElementNode && node.Data == "a" && htmlClass(node, "authorName")
			}) {
				authors = append(authors, htmlText(author))
			}
			if image := htmlByClass(row, "bookCover"); image != nil {
				cover = htmlAttr(image, "src")
			}
		}
		title, subtitle := splitBookTitle(title)
		result = append(result, Candidate{
			Reference: reference, Title: title, Subtitle: text(subtitle), Authors: people(authors, "author"),
			CoverURL: text(goodreadsCover(cover)), Tags: []string{}, Genres: []string{}, Moods: []string{}, Identifiers: []Identifier{},
		})
	}
	return result, nil
}

func (p *adapter) goodreads(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	if ref != "" {
		data, err := p.fetch(ctx, "/book/show/"+ref, nil, nil, "text/html")
		if err != nil {
			return nil, err
		}
		candidate, err := parseGoodreadsPage(data, ref, "")
		if err != nil {
			return nil, err
		}
		return finish(p.name, []Candidate{candidate})
	}
	if q.ISBN != "" {
		if data, err := p.fetch(ctx, "/book/isbn/"+q.ISBN, nil, nil, "text/html"); err == nil {
			if candidate, err := parseGoodreadsPage(data, "", q.ISBN); err == nil {
				return finish(p.name, []Candidate{candidate})
			}
		}
	}
	query := queryText(q)
	if query == "" {
		return []Candidate{}, nil
	}
	if data, err := p.fetch(ctx, "/book/auto_complete", url.Values{"format": {"json"}, "q": {query}}, nil, "application/json"); err == nil {
		previews, parseErr := parseGoodreadsAutocomplete(data)
		if parseErr == nil && len(previews) > 0 {
			if detail, detailErr := p.fetch(ctx, "/book/show/"+previews[0].Reference, nil, nil, "text/html"); detailErr == nil {
				if candidate, pageErr := parseGoodreadsPage(detail, previews[0].Reference, ""); pageErr == nil {
					previews[0] = candidate
				}
			}
			return finish(p.name, previews)
		}
	}
	data, err := p.fetch(ctx, "/search", url.Values{"q": {query}}, nil, "text/html")
	if err != nil {
		return nil, err
	}
	previews, err := parseGoodreadsSearch(data)
	if err != nil {
		return nil, err
	}
	return finish(p.name, previews)
}

func amazonChallenge(doc *nethtml.Node) bool {
	page := strings.ToLower(htmlText(doc))
	return strings.Contains(page, "robot check") || strings.Contains(page, "enter the characters you see below") ||
		strings.Contains(page, "api-services-support@amazon.com")
}

func amazonSearchAuthors(node *nethtml.Node) []string {
	result := []string{}
	for _, anchor := range htmlCollect(node, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "a"
	}) {
		href := htmlAttr(anchor, "href")
		if !strings.Contains(href, "/e/B") {
			continue
		}
		if name := strings.TrimSpace(htmlText(anchor)); name != "" {
			result = append(result, name)
		}
	}
	return unique(result)
}

func parseAmazonSearch(data []byte) ([]Candidate, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return nil, failure("invalid_response")
	}
	if amazonChallenge(doc) {
		return nil, failure("upstream_error")
	}
	result := []Candidate{}
	seen := map[string]bool{}
	for _, item := range htmlCollect(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "div" &&
			htmlAttr(node, "data-component-type") == "s-search-result" && htmlAttr(node, "data-asin") != ""
	}) {
		reference := strings.TrimSpace(htmlAttr(item, "data-asin"))
		if reference == "" || seen[reference] {
			continue
		}
		title := ""
		if heading := htmlFind(item, func(node *nethtml.Node) bool {
			return node.Type == nethtml.ElementNode && node.Data == "h2"
		}); heading != nil {
			title = strings.TrimSpace(htmlText(heading))
		}
		if title == "" {
			continue
		}
		seen[reference] = true
		title, subtitle := splitBookTitle(title)
		cover := ""
		if image := htmlFind(item, func(node *nethtml.Node) bool {
			return node.Type == nethtml.ElementNode && node.Data == "img" && htmlClass(node, "s-image")
		}); image != nil {
			cover = htmlAttr(image, "src")
		}
		result = append(result, Candidate{
			Reference: reference, Title: title, Subtitle: text(subtitle),
			Authors: people(amazonSearchAuthors(item), "author"), CoverURL: text(cover),
			Tags: []string{}, Genres: []string{}, Moods: []string{}, Identifiers: []Identifier{},
		})
	}
	return result, nil
}

func amazonTextByID(doc *nethtml.Node, id string) string {
	if node := htmlByID(doc, id); node != nil {
		return strings.TrimSpace(htmlText(node))
	}
	return ""
}

func amazonDetailValue(details map[string]string, names ...string) string {
	for _, name := range names {
		for label, value := range details {
			if strings.Contains(label, name) && strings.TrimSpace(value) != "" {
				return strings.TrimSpace(value)
			}
		}
	}
	return ""
}

func amazonDetails(doc *nethtml.Node) map[string]string {
	details := map[string]string{}
	add := func(line string) {
		line = strings.Map(func(r rune) rune {
			switch r {
			case '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u2066', '\u2067', '\u2068', '\u2069':
				return -1
			}
			return r
		}, line)
		label, value, ok := strings.Cut(line, ":")
		if !ok {
			label, value, ok = strings.Cut(line, "\uff1a")
		}
		if ok && strings.TrimSpace(label) != "" {
			details[strings.ToLower(strings.TrimSpace(label))] = strings.TrimSpace(value)
		}
	}
	for _, id := range []string{"detailBullets_feature_div", "productDetails_detailBullets_sections1", "productDetails_techSpec_section_1"} {
		if container := htmlByID(doc, id); container != nil {
			for _, node := range htmlCollect(container, func(node *nethtml.Node) bool {
				return node.Type == nethtml.ElementNode && (node.Data == "li" || node.Data == "tr")
			}) {
				add(htmlText(node))
			}
		}
	}
	for _, node := range htmlCollect(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && htmlClass(node, "rpi-attribute")
	}) {
		label := htmlText(htmlByClass(node, "rpi-attribute-label"))
		value := htmlText(htmlByClass(node, "rpi-attribute-value"))
		if strings.TrimSpace(label) != "" && strings.TrimSpace(value) != "" {
			details[strings.ToLower(strings.TrimSpace(label))] = strings.TrimSpace(value)
		}
	}
	return details
}

func amazonAuthors(doc *nethtml.Node) []string {
	for _, id := range []string{"bylineInfo_feature_div", "bylineInfo"} {
		if container := htmlByID(doc, id); container != nil {
			result := []string{}
			for _, author := range htmlCollect(container, func(node *nethtml.Node) bool {
				return node.Type == nethtml.ElementNode && htmlClass(node, "author")
			}) {
				for _, anchor := range htmlCollect(author, func(node *nethtml.Node) bool {
					return node.Type == nethtml.ElementNode && node.Data == "a"
				}) {
					if name := strings.TrimSpace(htmlText(anchor)); name != "" {
						result = append(result, name)
					}
				}
			}
			if len(result) == 0 {
				for _, anchor := range htmlCollect(container, func(node *nethtml.Node) bool {
					return node.Type == nethtml.ElementNode && node.Data == "a" && strings.Contains(htmlAttr(node, "href"), "/e/B")
				}) {
					if name := strings.TrimSpace(htmlText(anchor)); name != "" {
						result = append(result, name)
					}
				}
			}
			if len(result) > 0 {
				return unique(result)
			}
		}
	}
	return nil
}

func amazonCover(doc *nethtml.Node) string {
	for _, id := range []string{"ebooksImgBlkFront", "imgBlkFront", "landingImage"} {
		if image := htmlByID(doc, id); image != nil {
			if src := htmlAttr(image, "src"); src != "" {
				return src
			}
		}
	}
	if image := htmlFind(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "img" && strings.Contains(htmlAttr(node, "class"), "book")
	}); image != nil {
		if src := htmlAttr(image, "src"); src != "" {
			return src
		}
	}
	return ""
}

func amazonDescription(doc *nethtml.Node) string {
	for _, id := range []string{"bookDescription_feature_div", "productDescription", "bookDescription"} {
		if node := htmlByID(doc, id); node != nil {
			if value := strings.TrimSpace(htmlText(node)); value != "" {
				return value
			}
		}
	}
	return ""
}

func amazonGenres(doc *nethtml.Node) []string {
	container := htmlByID(doc, "wayfinding-breadcrumbs_feature_div")
	if container == nil {
		return []string{}
	}
	result := []string{}
	for _, anchor := range htmlCollect(container, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "a"
	}) {
		if name := strings.TrimSpace(htmlText(anchor)); name != "" && !strings.EqualFold(name, "Books") {
			result = append(result, name)
		}
	}
	return unique(result)
}

func parseAmazonBook(data []byte, fallbackRef string) (Candidate, error) {
	doc, err := nethtml.Parse(bytes.NewReader(data))
	if err != nil {
		return Candidate{}, failure("invalid_response")
	}
	if amazonChallenge(doc) {
		return Candidate{}, failure("upstream_error")
	}
	title := ""
	for _, id := range []string{"productTitle", "ebooksProductTitle", "title"} {
		if title = amazonTextByID(doc, id); title != "" {
			break
		}
	}
	if title == "" {
		title = strings.TrimPrefix(amazonTextByID(doc, "title"), "Amazon.com: ")
	}
	if title == "" {
		return Candidate{}, failure("invalid_response")
	}
	reference := fallbackRef
	if canonical := htmlFind(doc, func(node *nethtml.Node) bool {
		return node.Type == nethtml.ElementNode && node.Data == "link" && strings.EqualFold(htmlAttr(node, "rel"), "canonical")
	}); canonical != nil {
		if match := amazonReferenceText.FindStringSubmatch(htmlAttr(canonical, "href")); match != nil {
			reference = match[1]
		}
	}
	if reference == "" {
		return Candidate{}, failure("invalid_response")
	}
	title, subtitle := splitBookTitle(title)
	details := amazonDetails(doc)
	publisher := amazonDetailValue(details, "publisher")
	if index := strings.Index(publisher, ";"); index >= 0 {
		publisher = publisher[:index]
	}
	if index := strings.Index(publisher, "("); index >= 0 {
		publisher = publisher[:index]
	}
	publication := amazonDetailValue(details, "publication date", "date")
	if publication == "" {
		if index := strings.Index(amazonDetailValue(details, "publisher"), "("); index >= 0 {
			publication = strings.TrimSuffix(strings.TrimSpace(amazonDetailValue(details, "publisher")[index+1:]), ")")
		}
	}
	cover := amazonCover(doc)
	if cover == "" {
		cover = htmlAttr(htmlFind(doc, func(node *nethtml.Node) bool {
			return node.Type == nethtml.ElementNode && node.Data == "meta" && strings.EqualFold(htmlAttr(node, "property"), "og:image")
		}), "content")
	}
	c := Candidate{
		Reference: reference, Title: title, Subtitle: text(subtitle), Authors: people(amazonAuthors(doc), "author"),
		Description: text(amazonDescription(doc)), Publisher: text(publisher), PublishedDate: date(publication),
		Language: text(amazonDetailValue(details, "language")), CoverURL: text(cover),
		Tags: []string{}, Genres: amazonGenres(doc), Moods: []string{},
		Identifiers: isbnIdentifiers([]string{amazonDetailValue(details, "isbn-10", "isbn 10"), amazonDetailValue(details, "isbn-13", "isbn 13")}),
	}
	if pageCount := leadingInt(strings.ReplaceAll(amazonDetailValue(details, "print length", "pages", "paperback", "hardcover"), ",", "")); pageCount > 0 {
		c.PageCount = pages(pageCount)
	}
	ratingText := ""
	for _, id := range []string{"acrPopover", "averageCustomerReviews"} {
		if node := htmlByID(doc, id); node != nil {
			ratingText = htmlAttr(node, "title") + " " + htmlText(node)
		}
	}
	if match := amazonRatingText.FindStringSubmatch(ratingText); match != nil {
		if value, err := strconv.ParseFloat(match[1], 64); err == nil {
			count := int64(leadingInt(strings.ReplaceAll(amazonTextByID(doc, "acrCustomerReviewText"), ",", "")))
			c.Rating, c.RatingCount = rating(&value, 5, &count)
		}
	}
	return c, nil
}

func isbn10(value string) (string, bool) {
	value = strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(value))
	if len(value) == 10 {
		return value, true
	}
	if len(value) != 13 || !strings.HasPrefix(value, "978") {
		return "", false
	}
	sum := 0
	for index, digit := range value[3:12] {
		if digit < '0' || digit > '9' {
			return "", false
		}
		sum += int(digit-'0') * (10 - index)
	}
	check := 11 - sum%11
	if check == 10 {
		return value[3:12] + "X", true
	}
	if check == 11 {
		return value[3:12] + "0", true
	}
	return value[3:12] + string(rune('0'+check)), true
}

func (p *adapter) amazon(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	if ref != "" {
		data, err := p.fetch(ctx, "/dp/"+ref, nil, nil, "text/html")
		if err != nil {
			return nil, err
		}
		candidate, err := parseAmazonBook(data, ref)
		if err != nil {
			return nil, err
		}
		return finish(p.name, []Candidate{candidate})
	}
	if isbn, ok := isbn10(q.ISBN); ok {
		if data, err := p.fetch(ctx, "/dp/"+isbn, nil, nil, "text/html"); err == nil {
			if candidate, parseErr := parseAmazonBook(data, isbn); parseErr == nil {
				return finish(p.name, []Candidate{candidate})
			}
		}
	}
	query := q.ISBN
	if query == "" {
		query = strings.TrimSpace(strings.Join([]string{q.Title, q.Author}, " "))
	}
	if query == "" {
		return []Candidate{}, nil
	}
	data, err := p.fetch(ctx, "/s", url.Values{"k": {query}}, nil, "text/html")
	if err != nil {
		return nil, err
	}
	items, err := parseAmazonSearch(data)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return []Candidate{}, nil
	}
	if detail, err := p.fetch(ctx, "/dp/"+items[0].Reference, nil, nil, "text/html"); err == nil {
		if candidate, parseErr := parseAmazonBook(detail, items[0].Reference); parseErr == nil {
			items[0] = candidate
		}
	}
	return finish(p.name, items)
}

type openDocument struct {
	Key       string   `json:"key"`
	Title     string   `json:"title"`
	Subtitle  string   `json:"subtitle"`
	Authors   []string `json:"author_name"`
	Publisher []string `json:"publisher"`
	Year      int64    `json:"first_publish_year"`
	Languages []string `json:"language"`
	Pages     int64    `json:"number_of_pages_median"`
	Subjects  []string `json:"subject"`
	ISBN      []string `json:"isbn"`
	Cover     int64    `json:"cover_i"`
	Rating    *float64 `json:"ratings_average"`
	Ratings   *int64   `json:"ratings_count"`
	Series    []string `json:"series_name"`
	Positions []string `json:"series_position"`
}

// Open Library subjects are unbounded folksonomy; keep the most common ones.
const maxOpenLibrarySubjects = 20

func (p *adapter) openLibrary(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	v := url.Values{
		"limit": {"10"},
		"fields": {"key,title,subtitle,author_name,publisher,first_publish_year,language,number_of_pages_median,subject,isbn,cover_i," +
			"ratings_average,ratings_count,series_name,series_position"},
	}
	if ref != "" {
		v.Set("q", "key:"+ref)
	} else if q.ISBN != "" {
		v.Set("isbn", q.ISBN)
	} else {
		v.Set("title", q.Title)
		if q.Author != "" {
			v.Set("author", q.Author)
		}
		if q.Language != "" {
			v.Set("lang", q.Language)
		}
	}
	var response struct {
		Docs *[]openDocument `json:"docs"`
	}
	if err := p.request(ctx, "/search.json", v, nil, &response); err != nil {
		return nil, err
	}
	if response.Docs == nil {
		return nil, failure("invalid_response")
	}
	result := []Candidate{}
	for _, doc := range *response.Docs {
		subjects := unique(doc.Subjects)
		if len(subjects) > maxOpenLibrarySubjects {
			subjects = subjects[:maxOpenLibrarySubjects]
		}
		c := Candidate{
			Reference: doc.Key, Title: doc.Title, Subtitle: text(doc.Subtitle), Authors: people(doc.Authors, "author"),
			Publisher: text(first(doc.Publisher)), Language: text(first(doc.Languages)), PageCount: pages(doc.Pages),
			Tags: subjects, Identifiers: isbnIdentifiers(doc.ISBN),
		}
		c.Rating, c.RatingCount = rating(doc.Rating, 5, doc.Ratings)
		if doc.Year > 0 {
			c.PublishedDate = date(strconv.FormatInt(doc.Year, 10))
		}
		if doc.Cover > 0 {
			c.CoverURL = text(fmt.Sprintf("https://covers.openlibrary.org/b/id/%d-L.jpg", doc.Cover))
		}
		if name := strings.TrimSpace(first(doc.Series)); name != "" {
			c.Series = &Series{Name: name, Index: position(first(doc.Positions))}
		}
		result = append(result, c)
	}
	// Search documents carry no description; fetch the top work's description best-effort.
	if len(result) > 0 && strings.HasPrefix(result[0].Reference, "/works/") && openReference.MatchString(result[0].Reference) {
		result[0].Description = p.openLibraryDescription(ctx, result[0].Reference)
	}
	return finish(p.name, result)
}

func (p *adapter) openLibraryDescription(ctx context.Context, key string) *string {
	var work struct {
		Description json.RawMessage `json:"description"`
	}
	if p.request(ctx, key+".json", nil, nil, &work) != nil || len(work.Description) == 0 {
		return nil
	}
	var value string
	if json.Unmarshal(work.Description, &value) == nil {
		return text(value)
	}
	var typed struct {
		Value string `json:"value"`
	}
	if json.Unmarshal(work.Description, &typed) == nil {
		return text(typed.Value)
	}
	return nil
}

// position parses a numeric series position such as "1" or "2.5".
func position(value string) *float64 {
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) || number < 0 {
		return nil
	}
	return &number
}

// rating normalizes a provider rating on a 0..scale range to 0..5 with two decimals.
// Ratings without votes or outside the provider scale are dropped.
func rating(value *float64, scale float64, count *int64) (*float64, *int64) {
	if value == nil || math.IsNaN(*value) || *value < 0 || *value > scale || (count != nil && *count <= 0) {
		return nil, nil
	}
	normalized := math.Round(*value/scale*5*100) / 100
	if normalized == 0 && count == nil {
		return nil, nil
	}
	return &normalized, count
}

func seriesTotal(values ...*int64) *int64 {
	for _, value := range values {
		if value != nil && *value >= 1 {
			return value
		}
	}
	return nil
}

type googleVolume struct {
	ID   string `json:"id"`
	Info struct {
		Title         string   `json:"title"`
		Subtitle      string   `json:"subtitle"`
		Authors       []string `json:"authors"`
		Description   string   `json:"description"`
		Publisher     string   `json:"publisher"`
		PublishedDate string   `json:"publishedDate"`
		Language      string   `json:"language"`
		PageCount     int64    `json:"pageCount"`
		Categories    []string `json:"categories"`
		AverageRating *float64 `json:"averageRating"`
		RatingsCount  *int64   `json:"ratingsCount"`
		Maturity      string   `json:"maturityRating"`
		Identifiers   []struct {
			Type  string `json:"type"`
			Value string `json:"identifier"`
		} `json:"industryIdentifiers"`
		Images struct {
			SmallThumbnail string `json:"smallThumbnail"`
			Thumbnail      string `json:"thumbnail"`
			Small          string `json:"small"`
			Medium         string `json:"medium"`
			Large          string `json:"large"`
			ExtraLarge     string `json:"extraLarge"`
		} `json:"imageLinks"`
	} `json:"volumeInfo"`
}

// googleCategories splits BISAC-style "Fiction / Science Fiction / General" paths into genres.
func googleCategories(categories []string) []string {
	result := []string{}
	for _, category := range categories {
		for _, part := range strings.Split(category, "/") {
			part = strings.TrimSpace(part)
			if part != "" && !strings.EqualFold(part, "General") {
				result = append(result, part)
			}
		}
	}
	return unique(result)
}

func googleCover(info *googleVolume) *string {
	images := info.Info.Images
	for _, link := range []string{images.ExtraLarge, images.Large, images.Medium, images.Small, images.Thumbnail, images.SmallThumbnail} {
		if link = strings.TrimSpace(link); link != "" {
			return text(strings.Replace(link, "&edge=curl", "", 1))
		}
	}
	return nil
}

func (p *adapter) googleBooks(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	v := url.Values{}
	var volumes []googleVolume
	if ref != "" {
		var volume googleVolume
		if err := p.request(ctx, "/books/v1/volumes/"+ref, v, nil, &volume); err != nil {
			return nil, err
		}
		volumes = append(volumes, volume)
	} else {
		query := "isbn:" + q.ISBN
		if q.ISBN == "" {
			query = "intitle:" + strconv.Quote(q.Title)
			if q.Author != "" {
				query += " inauthor:" + strconv.Quote(q.Author)
			}
			if q.Language != "" {
				v.Set("langRestrict", q.Language)
			}
		}
		v.Set("q", query)
		v.Set("maxResults", "10")
		var response struct {
			Total *int64         `json:"totalItems"`
			Items []googleVolume `json:"items"`
		}
		if err := p.request(ctx, "/books/v1/volumes", v, nil, &response); err != nil {
			return nil, err
		}
		if response.Total == nil || (*response.Total > 0 && response.Items == nil) {
			return nil, failure("invalid_response")
		}
		volumes = response.Items
	}
	result := []Candidate{}
	for _, volume := range volumes {
		info := volume.Info
		c := Candidate{
			Reference: volume.ID, Title: info.Title, Subtitle: text(info.Subtitle), Authors: people(info.Authors, "author"),
			Description: text(info.Description), Publisher: text(info.Publisher), PublishedDate: date(info.PublishedDate),
			Language: text(info.Language), PageCount: pages(info.PageCount), Genres: googleCategories(info.Categories),
			CoverURL: googleCover(&volume),
		}
		c.Rating, c.RatingCount = rating(info.AverageRating, 5, info.RatingsCount)
		switch info.Maturity {
		case "NOT_MATURE":
			c.ContentRating = text("everyone")
		case "MATURE":
			c.ContentRating = text("mature")
		}
		isbns := []string{}
		for _, id := range info.Identifiers {
			if id.Type == "ISBN_10" || id.Type == "ISBN_13" {
				isbns = append(isbns, id.Value)
			}
		}
		c.Identifiers = isbnIdentifiers(isbns)
		result = append(result, c)
	}
	return finish(p.name, result)
}

type neoBook struct {
	UUID        string          `json:"uuid"`
	Title       string          `json:"title"`
	Subtitle    string          `json:"display_subtitle"`
	SubtitleRaw *string         `json:"subtitle"`
	Description string          `json:"description"`
	Brief       string          `json:"brief"`
	Authors     []string        `json:"author"`
	Translators []string        `json:"translator"`
	Publishers  []string        `json:"publisher"`
	PubHouse    string          `json:"pub_house"`
	Languages   []string        `json:"language"`
	Year        int             `json:"pub_year"`
	Month       int             `json:"pub_month"`
	Pages       json.RawMessage `json:"pages"`
	Series      string          `json:"series"`
	ISBN        string          `json:"isbn"`
	Cover       string          `json:"cover_image_url"`
	Tags        []string        `json:"tags"`
	Rating      *float64        `json:"rating"`
	RatingCount *int64          `json:"rating_count"`
	External    []struct {
		URL string `json:"url"`
	} `json:"external_resources"`
}

var (
	goodreadsURL = regexp.MustCompile(`^https://(?:www\.)?goodreads\.com/book/show/([0-9]{1,20})(?:[^0-9]|$)`)
	doubanURL    = regexp.MustCompile(`^https://book\.douban\.com/subject/([0-9]{1,20})/?$`)
)

// neoExternalIdentifiers extracts well-known catalog IDs from NeoDB's linked resources.
func neoExternalIdentifiers(book neoBook) []Identifier {
	result := []Identifier{}
	seen := map[string]bool{}
	for _, resource := range book.External {
		for scheme, pattern := range map[string]*regexp.Regexp{"goodreads": goodreadsURL, "douban": doubanURL} {
			if match := pattern.FindStringSubmatch(resource.URL); match != nil && !seen[scheme] {
				result = append(result, Identifier{Scheme: scheme, Value: match[1]})
				seen[scheme] = true
			}
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Scheme < result[j].Scheme })
	return result
}

func queryText(q Query) string {
	if q.ISBN != "" {
		return q.ISBN
	}
	return strings.TrimSpace(strings.Join([]string{q.Title, q.Author, q.Language}, " "))
}

func (p *adapter) neoDB(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	var books []neoBook
	if ref != "" {
		var book neoBook
		if err := p.request(ctx, "/api/book/"+ref, nil, nil, &book); err != nil {
			return nil, err
		}
		books = append(books, book)
	} else {
		var response struct {
			Data *[]neoBook `json:"data"`
		}
		if err := p.request(ctx, "/api/catalog/search", url.Values{"query": {queryText(q)}, "category": {"book"}}, nil, &response); err != nil {
			return nil, err
		}
		if response.Data == nil {
			return nil, failure("invalid_response")
		}
		books = *response.Data
	}
	result := []Candidate{}
	for _, book := range books {
		var pageNumber int64
		if len(book.Pages) != 0 && string(book.Pages) != "null" {
			if err := json.Unmarshal(book.Pages, &pageNumber); err != nil {
				var value string
				if json.Unmarshal(book.Pages, &value) != nil {
					return nil, failure("invalid_response")
				}
				number, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
				if err != nil && value != "" {
					return nil, failure("invalid_response")
				}
				pageNumber = number
			}
		}
		c := Candidate{
			Reference: book.UUID, Title: book.Title, Subtitle: text(book.Subtitle),
			Authors:     append(people(book.Authors, "author"), people(book.Translators, "translator")...),
			Description: text(book.Description), Publisher: text(strings.Join(book.Publishers, " / ")),
			Language: text(first(book.Languages)), PageCount: pages(pageNumber), Tags: book.Tags,
			Identifiers: append(isbnIdentifiers([]string{book.ISBN}), neoExternalIdentifiers(book)...), CoverURL: text(book.Cover),
		}
		if c.Subtitle == nil && book.SubtitleRaw != nil {
			c.Subtitle = text(*book.SubtitleRaw)
		}
		if c.Description == nil {
			c.Description = text(book.Brief)
		}
		if c.Publisher == nil {
			c.Publisher = text(book.PubHouse)
		}
		c.Rating, c.RatingCount = rating(book.Rating, 10, book.RatingCount)
		if book.Year > 0 {
			value := fmt.Sprintf("%04d", book.Year)
			if book.Month > 0 {
				value += fmt.Sprintf("-%02d", book.Month)
			}
			c.PublishedDate = date(value)
		}
		if book.Series != "" {
			c.Series = &Series{Name: book.Series}
		}
		result = append(result, c)
	}
	return finish(p.name, result)
}

type hardcoverBook struct {
	ID           json.Number `json:"id"`
	Title        string      `json:"title"`
	Subtitle     string      `json:"subtitle"`
	Authors      []string    `json:"author_names"`
	Contributors []struct {
		Role   string `json:"contribution"`
		Author struct {
			Name string `json:"name"`
		} `json:"author"`
	} `json:"contributions"`
	Description string     `json:"description"`
	Pages       int64      `json:"pages"`
	ISBNs       []string   `json:"isbns"`
	Tags        termList   `json:"tags"`
	Genres      termList   `json:"genres"`
	Moods       termList   `json:"moods"`
	CachedTags  cachedTags `json:"cached_tags"`
	Rating      *float64   `json:"rating"`
	RatingCount *int64     `json:"ratings_count"`
	Year        int        `json:"release_year"`
	Date        string     `json:"release_date"`
	Image       struct {
		URL string `json:"url"`
	} `json:"image"`
	Series   hardcoverSeries `json:"featured_series"`
	Position *float64        `json:"featured_series_position"`
}

// hardcoverSeries accepts the nested {position, series: {name, books_count}} shape
// and the older flat {name} shape.
type hardcoverSeries struct {
	Name         string   `json:"name"`
	Position     *float64 `json:"position"`
	BooksCount   *int64   `json:"books_count"`
	PrimaryCount *int64   `json:"primary_books_count"`
	Series       *struct {
		Name         string `json:"name"`
		BooksCount   *int64 `json:"books_count"`
		PrimaryCount *int64 `json:"primary_books_count"`
	} `json:"series"`
}

// termList accepts tag arrays of strings or of {"tag": ...}/{"name": ...} objects.
type termList []string

func (t *termList) UnmarshalJSON(data []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
			*t = nil
			return nil
		}
		return err
	}
	result := make([]string, 0, len(raw))
	for _, item := range raw {
		var value string
		if json.Unmarshal(item, &value) == nil {
			result = append(result, value)
			continue
		}
		var object struct {
			Tag  string `json:"tag"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(item, &object); err != nil {
			return err
		}
		if object.Tag == "" {
			object.Tag = object.Name
		}
		result = append(result, object.Tag)
	}
	*t = result
	return nil
}

// cachedTags is Hardcover's per-book tag cache keyed by category ("Genre", "Mood", "Tag", ...).
// Unexpected shapes are ignored rather than failing the whole record.
type cachedTags map[string]termList

func (c *cachedTags) UnmarshalJSON(data []byte) error {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		var encoded string
		if json.Unmarshal(data, &encoded) != nil || json.Unmarshal([]byte(encoded), &raw) != nil {
			*c = nil
			return nil
		}
	}
	result := cachedTags{}
	for category, value := range raw {
		var terms termList
		if json.Unmarshal(value, &terms) == nil {
			result[category] = terms
		}
	}
	*c = result
	return nil
}

func (p *adapter) hardcover(ctx context.Context, q Query, ref string) ([]Candidate, error) {
	body := map[string]any{
		"query":     `query Search($query: String!) { search(query: $query, query_type: "Book", per_page: 10, page: 1) { results } }`,
		"variables": map[string]any{"query": queryText(q)},
	}
	if ref != "" {
		id, err := strconv.ParseInt(ref, 10, 64)
		if err != nil || id < 1 {
			return nil, ErrInvalid
		}
		body = map[string]any{
			"query":     `query Book($id: Int!) { books(where: {id: {_eq: $id}}, limit: 1) { id title subtitle description pages release_date rating ratings_count cached_tags contributions { contribution author { name } } image: cached_image featured_series: cached_featured_series } }`,
			"variables": map[string]any{"id": id},
		}
	}
	var response struct {
		Data struct {
			Search *struct {
				Results json.RawMessage `json:"results"`
			} `json:"search"`
			Books []json.RawMessage `json:"books"`
		} `json:"data"`
		Errors []json.RawMessage `json:"errors"`
	}
	if err := p.request(ctx, "/v1/graphql", nil, body, &response); err != nil {
		return nil, err
	}
	if len(response.Errors) > 0 {
		return nil, failure("upstream_error")
	}
	var books []hardcoverBook
	if ref != "" {
		if response.Data.Books == nil {
			return nil, failure("invalid_response")
		}
		for _, raw := range response.Data.Books {
			var book hardcoverBook
			if json.Unmarshal(raw, &book) != nil {
				return nil, failure("invalid_response")
			}
			books = append(books, book)
		}
	} else {
		if response.Data.Search == nil {
			return nil, failure("invalid_response")
		}
		raw := response.Data.Search.Results
		if len(raw) > 0 && raw[0] == '"' {
			var encoded string
			if json.Unmarshal(raw, &encoded) != nil {
				return nil, failure("invalid_response")
			}
			raw = []byte(encoded)
		}
		var results struct {
			Hits *[]struct {
				Document hardcoverBook `json:"document"`
			} `json:"hits"`
		}
		if json.Unmarshal(raw, &results) != nil || results.Hits == nil {
			return nil, failure("invalid_response")
		}
		for _, hit := range *results.Hits {
			books = append(books, hit.Document)
		}
	}
	result := []Candidate{}
	for _, book := range books {
		c := Candidate{
			Reference: book.ID.String(), Title: book.Title, Subtitle: text(book.Subtitle),
			Authors: people(book.Authors, "author"), Description: text(book.Description),
			PageCount: pages(book.Pages), Tags: append(book.Tags, book.CachedTags["Tag"]...),
			Genres: append(book.Genres, book.CachedTags["Genre"]...), Moods: append(book.Moods, book.CachedTags["Mood"]...),
			Identifiers: isbnIdentifiers(book.ISBNs), CoverURL: text(book.Image.URL), PublishedDate: date(book.Date),
		}
		c.Rating, c.RatingCount = rating(book.Rating, 5, book.RatingCount)
		if len(book.Contributors) > 0 {
			c.Authors = []Person{}
			for _, contributor := range book.Contributors {
				role := strings.ToLower(contributor.Role)
				if role == "" {
					role = "author"
				}
				switch role {
				case "author", "translator", "editor", "illustrator":
					c.Authors = append(c.Authors, people([]string{contributor.Author.Name}, role)...)
				}
			}
		}
		if c.PublishedDate == nil && book.Year > 0 {
			c.PublishedDate = date(strconv.Itoa(book.Year))
		}
		series := book.Series
		name, index, total := series.Name, book.Position, seriesTotal(series.PrimaryCount, series.BooksCount)
		if series.Series != nil {
			name = series.Series.Name
			total = seriesTotal(series.Series.PrimaryCount, series.Series.BooksCount)
		}
		if index == nil {
			index = series.Position
		}
		if name = strings.TrimSpace(name); name != "" {
			c.Series = &Series{Name: name, Index: index, Total: total}
		}
		result = append(result, c)
	}
	return finish(p.name, result)
}

func lookupFailure(err error) *LookupError {
	code := "provider_error"
	var provider *providerError
	switch {
	case errors.As(err, &provider):
		code = provider.code
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		code = "timeout"
	}
	return &LookupError{Code: code, Message: "Metadata provider lookup failed (" + code + ")."}
}
