package opds

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode"

	"pandalibrary/internal/auth"
	"pandalibrary/internal/catalog"
	"pandalibrary/internal/httpapi"
	"pandalibrary/internal/search"

	"github.com/go-chi/chi/v5"
)

const (
	realm            = `Basic realm="PandaLibrary OPDS", charset="UTF-8"`
	maxUsernameLen   = 128
	maxPasswordLen   = 128
	statusReading    = "reading"
	statusWantToRead = "want_to_read"
)

// Options configures the OPDS adapter.
type Options struct {
	Catalog *catalog.Service
	Search  *search.Service
	Auth    *auth.Service
	Reader  *sql.DB
	// BaseURL is the trusted public URL. When nil, links are root-relative and the
	// request's Host and forwarded headers are never used to build them.
	BaseURL *url.URL
	Logger  *slog.Logger
	Now     func() time.Time
}

type handler struct {
	catalog  *catalog.Service
	search   *search.Service
	auth     *auth.Service
	reader   *sql.DB
	origin   string
	basePath string
	logger   *slog.Logger
	now      func() time.Time
	limiter  *auth.RateLimiter
}

type viewerKey struct{}

// NewMount builds the HTTP Basic-authenticated OPDS 1.2 catalog mounted at /opds.
func NewMount(options Options) (httpapi.Mount, error) {
	if options.Catalog == nil || options.Search == nil || options.Auth == nil ||
		options.Reader == nil || options.Logger == nil {
		return nil, errors.New("OPDS requires catalog, search, authentication, a reader database, and a logger")
	}
	h := &handler{
		catalog: options.Catalog, search: options.Search, auth: options.Auth, reader: options.Reader,
		logger: options.Logger, now: options.Now, limiter: auth.NewRateLimiter(),
	}
	if h.now == nil {
		h.now = time.Now
	}
	if options.BaseURL != nil {
		if options.BaseURL.Scheme != "http" && options.BaseURL.Scheme != "https" || options.BaseURL.Host == "" {
			return nil, errors.New("OPDS base URL must be an absolute HTTP(S) URL")
		}
		h.origin = (&url.URL{Scheme: options.BaseURL.Scheme, Host: options.BaseURL.Host}).String()
		h.basePath = strings.TrimSuffix(options.BaseURL.Path, "/")
	}
	return h.mount, nil
}

func (h *handler) mount(router chi.Router, _ httpapi.Middleware) {
	router.Route("/opds", func(r chi.Router) {
		r.Use(h.authenticate)
		r.Get("/", h.root)
		r.Get("/opensearch.xml", h.openSearch)
		r.Get("/search", h.searchFeed)
		r.Get("/recent", h.recent)
		r.Get("/libraries", h.libraries)
		r.Get("/libraries/{id}", h.libraryBooks)
		for _, kind := range []string{"authors", "series", "tags"} {
			r.Get("/"+kind, h.entities(kind))
			r.Get("/"+kind+"/{id}", h.entityBooks(kind))
		}
		r.Get("/shelves", h.shelves)
		r.Get("/shelves/{id}", h.shelfBooks)
		r.Get("/reading", h.statusBooks(statusReading, "Reading now"))
		r.Get("/want-to-read", h.statusBooks(statusWantToRead, "Want to read"))
		for _, route := range []string{"/books/{id}/files/{fileID}", "/books/{id}/cover", "/books/{id}/thumbnail"} {
			serve := h.serveFile
			if route != "/books/{id}/files/{fileID}" {
				serve = h.serveCover(strings.HasSuffix(route, "thumbnail"))
			}
			r.Get(route, serve)
			r.Head(route, serve)
		}
		r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
			httpapi.WriteProblem(w, h.logger, http.StatusNotFound, "")
		})
		r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
			httpapi.WriteProblem(w, h.logger, http.StatusMethodNotAllowed, "")
		})
	})
}

func (h *handler) unauthorized(w http.ResponseWriter) {
	w.Header().Set("WWW-Authenticate", realm)
	w.Header().Set("Cache-Control", "no-store")
	httpapi.WriteProblem(w, h.logger, http.StatusUnauthorized, "")
}

// authenticate accepts only HTTP Basic credentials holding an OPDS-kind app password.
func (h *handler) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers := r.Header.Values("Authorization")
		if len(headers) == 0 {
			h.unauthorized(w)
			return
		}
		client := httpapi.ClientIP(r)
		if !h.limiter.Allow(client, h.now()) {
			w.Header().Set("Retry-After", "600")
			w.Header().Set("Cache-Control", "no-store")
			httpapi.WriteProblem(w, h.logger, http.StatusTooManyRequests, "")
			return
		}
		username, password, ok := r.BasicAuth()
		if len(headers) != 1 || !ok || username == "" || password == "" ||
			len(username) > maxUsernameLen || len(password) > maxPasswordLen {
			h.unauthorized(w)
			return
		}
		user, err := h.auth.VerifyAppPassword(r.Context(), username, "opds", password)
		if errors.Is(err, auth.ErrInvalidCredentials) {
			h.unauthorized(w)
			return
		}
		if err != nil {
			h.logger.Error("verify OPDS credentials", "request_id", httpapi.RequestID(r), "error", err)
			httpapi.WriteProblem(w, h.logger, http.StatusInternalServerError, "")
			return
		}
		h.limiter.Reset(client)
		viewer := catalog.Viewer{UserID: user.ID, IsAdmin: user.Role == "admin"}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), viewerKey{}, viewer)))
	})
}

func viewerFrom(r *http.Request) catalog.Viewer {
	viewer, _ := r.Context().Value(viewerKey{}).(catalog.Viewer)
	return viewer
}

// href builds an escaped link from the trusted base URL, or a root-relative link.
func (h *handler) href(route string, query url.Values) string {
	link := url.URL{Path: h.basePath + route}
	if len(query) > 0 {
		link.RawQuery = query.Encode()
	}
	return h.origin + link.String()
}

func (h *handler) commonLinks(self link, up string) []link {
	links := []link{
		self,
		{Rel: "start", Href: h.href("/opds", nil), Type: NavigationType, Title: "PandaLibrary"},
	}
	if up != "" {
		links = append(links, link{Rel: "up", Href: h.href(up, nil), Type: NavigationType})
	}
	return append(links, link{Rel: "search", Href: h.href("/opds/opensearch.xml", nil), Type: OpenSearchType, Title: "Search"})
}

func (h *handler) navEntry(id, title, content, rel, route string, kind string) entry {
	return entry{
		ID: "urn:pandalibrary:opds:" + id, Title: title, Updated: atomTime(h.now()),
		Content: &textConstruct{Type: "text", Value: content},
		Links:   []link{{Rel: rel, Href: h.href(route, nil), Type: kind}},
	}
}

func (h *handler) root(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	result := newFeed("urn:pandalibrary:opds:root", "PandaLibrary", h.now())
	result.Links = h.commonLinks(link{Rel: "self", Href: h.href("/opds", nil), Type: NavigationType}, "")
	result.Entries = []entry{
		h.navEntry("recent", "Recently added", "Books most recently added to your libraries", relSortNew, "/opds/recent", AcquisitionType),
		h.navEntry("libraries", "Libraries", "Browse books by library", "subsection", "/opds/libraries", NavigationType),
		h.navEntry("authors", "Authors", "Browse books by author", "subsection", "/opds/authors", NavigationType),
		h.navEntry("series", "Series", "Browse books by series", "subsection", "/opds/series", NavigationType),
		h.navEntry("tags", "Tags", "Browse books by tag", "subsection", "/opds/tags", NavigationType),
		h.navEntry("shelves", "Shelves", "Your private shelves and shared shelves", "subsection", "/opds/shelves", NavigationType),
		h.navEntry("reading", "Reading now", "Books you are currently reading", "subsection", "/opds/reading", AcquisitionType),
		h.navEntry("want-to-read", "Want to read", "Books you want to read", "subsection", "/opds/want-to-read", AcquisitionType),
	}
	h.writeFeed(w, r, result, NavigationType)
}

func (h *handler) openSearch(w http.ResponseWriter, r *http.Request) {
	if _, ok := h.query(w, r); !ok {
		return
	}
	body, err := encodeXML(openSearchDescription{
		Namespace: openSearchNamespace, ShortName: "PandaLibrary",
		Description: "Search the PandaLibrary catalog", InputEncoding: "UTF-8", OutputEncoding: "UTF-8",
		URL: openSearchURL{Type: AcquisitionType, Template: h.href("/opds/search", nil) + "?q={searchTerms}"},
	})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeBody(w, r, OpenSearchType, body)
}

func (h *handler) searchFeed(w http.ResponseWriter, r *http.Request) {
	values, ok := h.query(w, r, "q", "cursor")
	if !ok {
		return
	}
	text := values.Get("q")
	if strings.TrimSpace(text) == "" {
		httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, "A search query is required.")
		return
	}
	viewer := viewerFrom(r)
	results, err := h.search.Search(r.Context(), search.Viewer{UserID: viewer.UserID, IsAdmin: viewer.IsAdmin},
		text, search.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page := catalog.Page[catalog.Book]{Items: make([]catalog.Book, 0, len(results.Items)), NextCursor: results.NextCursor}
	for _, result := range results.Items {
		book, err := h.catalog.GetBook(r.Context(), viewer, result.ID)
		if errors.Is(err, catalog.ErrNotFound) {
			continue
		}
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		page.Items = append(page.Items, book)
	}
	context := url.Values{"q": {text}}
	h.writeBooks(w, r, "search", "Search: "+text, "/opds/search", "/opds", context, values.Get("cursor"), page)
}

func (h *handler) recent(w http.ResponseWriter, r *http.Request) {
	values, ok := h.query(w, r, "cursor")
	if !ok {
		return
	}
	page, err := h.catalog.ListBooks(r.Context(), viewerFrom(r), catalog.BookFilters{Sort: "added"},
		catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeBooks(w, r, "recent", "Recently added", "/opds/recent", "/opds", nil, values.Get("cursor"), page)
}

func (h *handler) libraries(w http.ResponseWriter, r *http.Request) {
	values, ok := h.query(w, r, "cursor")
	if !ok {
		return
	}
	page, err := h.catalog.ListLibraries(r.Context(), viewerFrom(r), catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	entries := make([]entry, 0, len(page.Items))
	for _, library := range page.Items {
		entries = append(entries, h.navEntry(fmt.Sprintf("library:%d", library.ID), library.Name,
			"Books in the "+library.Name+" library", "subsection", fmt.Sprintf("/opds/libraries/%d", library.ID), AcquisitionType))
	}
	h.writeNavigation(w, r, "libraries", "Libraries", "/opds/libraries", values.Get("cursor"), page.NextCursor, entries)
}

func (h *handler) libraryBooks(w http.ResponseWriter, r *http.Request) {
	id, values, ok := h.pathAndQuery(w, r)
	if !ok {
		return
	}
	viewer := viewerFrom(r)
	library, err := h.catalog.GetLibrary(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.catalog.ListBooks(r.Context(), viewer, catalog.BookFilters{LibraryID: id, Sort: "title"},
		catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeBooks(w, r, fmt.Sprintf("library:%d", id), library.Name, fmt.Sprintf("/opds/libraries/%d", id),
		"/opds/libraries", nil, values.Get("cursor"), page)
}

var entityTitles = map[string]string{"authors": "Authors", "series": "Series", "tags": "Tags"}

func (h *handler) entities(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		values, ok := h.query(w, r, "cursor")
		if !ok {
			return
		}
		page, err := h.catalog.ListEntities(r.Context(), viewerFrom(r), kind, catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		entries := make([]entry, 0, len(page.Items))
		for _, entity := range page.Items {
			entries = append(entries, h.navEntry(fmt.Sprintf("%s:%d", kind, entity.ID), entity.Name,
				bookCount(entity.VisibleBookCount), "subsection", fmt.Sprintf("/opds/%s/%d", kind, entity.ID), AcquisitionType))
		}
		h.writeNavigation(w, r, kind, entityTitles[kind], "/opds/"+kind, values.Get("cursor"), page.NextCursor, entries)
	}
}

func (h *handler) entityBooks(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, values, ok := h.pathAndQuery(w, r)
		if !ok {
			return
		}
		viewer := viewerFrom(r)
		entity, err := h.catalog.GetEntity(r.Context(), viewer, kind, id)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		filters := catalog.BookFilters{Sort: "title"}
		switch kind {
		case "authors":
			filters.AuthorID = id
		case "series":
			filters.SeriesID, filters.Sort = id, "series"
		case "tags":
			filters.TagID = id
		}
		page, err := h.catalog.ListBooks(r.Context(), viewer, filters, catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		h.writeBooks(w, r, fmt.Sprintf("%s:%d", kind, id), entity.Name, fmt.Sprintf("/opds/%s/%d", kind, id),
			"/opds/"+kind, nil, values.Get("cursor"), page)
	}
}

func (h *handler) shelves(w http.ResponseWriter, r *http.Request) {
	values, ok := h.query(w, r, "cursor")
	if !ok {
		return
	}
	page, err := h.catalog.ListShelves(r.Context(), viewerFrom(r), catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	entries := make([]entry, 0, len(page.Items))
	for _, shelf := range page.Items {
		content := bookCount(shelf.VisibleBookCount)
		if shelf.Kind == "shared" {
			content = "Shared shelf · " + content
		}
		entries = append(entries, h.navEntry(fmt.Sprintf("shelf:%d", shelf.ID), shelf.Name, content,
			"subsection", fmt.Sprintf("/opds/shelves/%d", shelf.ID), AcquisitionType))
	}
	h.writeNavigation(w, r, "shelves", "Shelves", "/opds/shelves", values.Get("cursor"), page.NextCursor, entries)
}

func (h *handler) shelfBooks(w http.ResponseWriter, r *http.Request) {
	id, values, ok := h.pathAndQuery(w, r)
	if !ok {
		return
	}
	viewer := viewerFrom(r)
	shelf, err := h.catalog.GetShelf(r.Context(), viewer, id)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	page, err := h.catalog.ListShelfBooks(r.Context(), viewer, id, catalog.PageOptions{Limit: pageSize, Cursor: values.Get("cursor")})
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeBooks(w, r, fmt.Sprintf("shelf:%d", id), shelf.Name, fmt.Sprintf("/opds/shelves/%d", id),
		"/opds/shelves", nil, values.Get("cursor"), page)
}

func (h *handler) statusBooks(status, title string) http.HandlerFunc {
	route := "/opds/reading"
	if status == statusWantToRead {
		route = "/opds/want-to-read"
	}
	return func(w http.ResponseWriter, r *http.Request) {
		values, ok := h.query(w, r, "cursor")
		if !ok {
			return
		}
		page, err := listByStatus(r.Context(), h.reader, h.catalog, viewerFrom(r), status, values.Get("cursor"))
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		h.writeBooks(w, r, strings.TrimPrefix(route, "/opds/"), title, route, "/opds", nil, values.Get("cursor"), page)
	}
}

func bookCount(count int64) string {
	if count == 1 {
		return "1 book"
	}
	return strconv.FormatInt(count, 10) + " books"
}

func pageQuery(context url.Values, cursor string) url.Values {
	query := url.Values{}
	for key, values := range context {
		query[key] = append([]string(nil), values...)
	}
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	return query
}

func (h *handler) writeNavigation(w http.ResponseWriter, r *http.Request, id, title, route, cursor string,
	next *string, entries []entry) {
	result := newFeed("urn:pandalibrary:opds:"+id, title, h.now())
	result.Links = h.commonLinks(link{Rel: "self", Href: h.href(route, pageQuery(nil, cursor)), Type: NavigationType}, "/opds")
	if next != nil {
		result.Links = append(result.Links, link{Rel: "next", Href: h.href(route, pageQuery(nil, *next)), Type: NavigationType})
	}
	result.Entries = entries
	h.writeFeed(w, r, result, NavigationType)
}

func (h *handler) writeBooks(w http.ResponseWriter, r *http.Request, id, title, route, up string,
	params url.Values, cursor string, page catalog.Page[catalog.Book]) {
	result := newFeed("urn:pandalibrary:opds:"+id, title, h.now())
	result.Links = h.commonLinks(link{Rel: "self", Href: h.href(route, pageQuery(params, cursor)), Type: AcquisitionType}, up)
	if page.NextCursor != nil {
		result.Links = append(result.Links, link{Rel: "next", Href: h.href(route, pageQuery(params, *page.NextCursor)), Type: AcquisitionType})
	}
	result.Entries = make([]entry, 0, len(page.Items))
	for _, book := range page.Items {
		// OPDS acquisition entries require an acquisition link; metadata-only books have nothing to download.
		if len(book.Files) == 0 {
			continue
		}
		result.Entries = append(result.Entries, h.bookEntry(book))
	}
	h.writeFeed(w, r, result, AcquisitionType)
}

func (h *handler) writeFeed(w http.ResponseWriter, r *http.Request, document feed, mediaType string) {
	body, err := encodeXML(document)
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.writeBody(w, r, mediaType, body)
}

func (h *handler) writeBody(w http.ResponseWriter, r *http.Request, mediaType string, body []byte) {
	w.Header().Set("Content-Type", mediaType+";charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Add("Vary", "Authorization")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(body); err != nil {
		h.logger.Warn("write OPDS response", "request_id", httpapi.RequestID(r), "error", err)
	}
}

func (h *handler) serveFile(w http.ResponseWriter, r *http.Request) {
	bookID, ok := h.pathID(w, r, "id")
	if !ok {
		return
	}
	fileID, ok := h.pathID(w, r, "fileID")
	if !ok {
		return
	}
	if _, ok := h.query(w, r); !ok {
		return
	}
	content, err := h.catalog.OpenBookFile(r.Context(), viewerFrom(r), bookID, fileID, "")
	if err != nil {
		h.writeError(w, r, err)
		return
	}
	h.serveContent(w, r, content, true)
}

func (h *handler) serveCover(thumbnail bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		bookID, ok := h.pathID(w, r, "id")
		if !ok {
			return
		}
		if _, ok := h.query(w, r); !ok {
			return
		}
		content, err := h.catalog.OpenCover(r.Context(), viewerFrom(r), bookID, thumbnail)
		if err != nil {
			h.writeError(w, r, err)
			return
		}
		h.serveContent(w, r, content, false)
	}
}

func (h *handler) serveContent(w http.ResponseWriter, r *http.Request, content catalog.Content, download bool) {
	defer func() {
		if err := content.File.Close(); err != nil {
			h.logger.Error("close OPDS content", "request_id", httpapi.RequestID(r), "error", err)
		}
	}()
	w.Header().Add("Vary", "Authorization")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", content.ContentType)
	w.Header().Set("ETag", `"`+content.ETag+`"`)
	if download {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{
			"filename": downloadName(content.Filename),
		}))
	}
	// Mutable URLs rely on ETags because timestamps can collide across replacements.
	http.ServeContent(w, r, content.Filename, time.Time{}, content.File)
}

func downloadName(name string) string {
	name = path.Base(strings.ReplaceAll(name, `\`, "/"))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if name == "" || name == "." || name == ".." || name == "/" {
		return "book"
	}
	return name
}

func (h *handler) pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil || id < 1 {
		httpapi.WriteProblem(w, h.logger, http.StatusNotFound, "")
		return 0, false
	}
	return id, true
}

func (h *handler) pathAndQuery(w http.ResponseWriter, r *http.Request) (int64, url.Values, bool) {
	id, ok := h.pathID(w, r, "id")
	if !ok {
		return 0, nil, false
	}
	values, ok := h.query(w, r, "cursor")
	return id, values, ok
}

// query rejects repeated or empty known parameters; unknown client parameters are ignored.
func (h *handler) query(w http.ResponseWriter, r *http.Request, allowed ...string) (url.Values, bool) {
	values, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, "The query string is invalid.")
		return nil, false
	}
	result := url.Values{}
	for _, key := range allowed {
		entries, present := values[key]
		if !present {
			continue
		}
		if len(entries) != 1 || entries[0] == "" {
			httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, "A query parameter is invalid.")
			return nil, false
		}
		result.Set(key, entries[0])
	}
	return result, true
}

func (h *handler) writeError(w http.ResponseWriter, r *http.Request, err error) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case errors.Is(err, errInvalidCursor):
		httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, errInvalidCursor.Error())
	case errors.Is(err, catalog.ErrInvalid):
		httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid request: "))
	case errors.Is(err, search.ErrInvalid):
		httpapi.WriteProblem(w, h.logger, http.StatusBadRequest, strings.TrimPrefix(err.Error(), "invalid search request: "))
	case errors.Is(err, catalog.ErrNotFound), errors.Is(err, catalog.ErrForbidden):
		httpapi.WriteProblem(w, h.logger, http.StatusNotFound, "")
	default:
		h.logger.Error("OPDS request failed", "request_id", httpapi.RequestID(r), "path", r.URL.Path, "error", err)
		httpapi.WriteProblem(w, h.logger, http.StatusInternalServerError, "")
	}
}
