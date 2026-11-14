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
)

const (
	maxResponseBytes = 2 << 20
	maxCandidates    = 10
	userAgent        = "PandaLibrary/1.0 (self-hosted ebook catalog; metadata lookup)"
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

func (p *adapter) request(ctx context.Context, path string, values url.Values, body any, dest any) error {
	if (p.name == "neodb" || p.name == "hardcover") && p.token == "" {
		return failure("credentials_required")
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
			return failure("invalid_request")
		}
		reader = bytes.NewReader(data)
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), reader)
	if err != nil {
		return failure("invalid_request")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if p.token != "" && (p.name == "neodb" || p.name == "hardcover") {
		req.Header.Set("Authorization", "Bearer "+strings.TrimPrefix(p.token, "Bearer "))
	}
	res, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return failure("network_error")
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return ErrNotFound
	case http.StatusTooManyRequests:
		return failure("rate_limited")
	case http.StatusUnauthorized, http.StatusForbidden:
		return failure("authentication_failed")
	default:
		return failure("upstream_error")
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBytes+1))
	if err != nil {
		return failure("response_read_failed")
	}
	if len(data) > maxResponseBytes {
		return failure("response_too_large")
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
	default:
		return nil, ErrInvalid
	}
}

var safeReference = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var openReference = regexp.MustCompile(`^/(works|books)/OL[0-9]+[WM]$`)

func (p *adapter) Get(ctx context.Context, ref string) (*Candidate, error) {
	if (p.name == "openlibrary" && !openReference.MatchString(ref)) ||
		(p.name != "openlibrary" && !safeReference.MatchString(ref)) {
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
	for _, layout := range []string{"2006-01-02", "2006-01", "2006", "January 2, 2006", "Jan 2, 2006"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			if layout == "2006" || layout == "2006-01" {
				return text(parsed.Format(layout))
			}
			return text(parsed.Format("2006-01-02"))
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
		c.Identifiers = append(c.Identifiers, Identifier{Scheme: name, Value: c.Reference})
		if c.CoverURL != nil && strings.HasPrefix(*c.CoverURL, "http://") && name != "neodb" {
			c.CoverURL = text("https://" + strings.TrimPrefix(*c.CoverURL, "http://"))
		}
	}
	if candidates == nil {
		candidates = []Candidate{}
	}
	return candidates, nil
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
