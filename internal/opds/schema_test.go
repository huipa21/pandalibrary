package opds

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// This file ports the OPDS 1.2 RELAX NG grammar (opds-community/specs schema/1.2/opds.rnc
// including atom.rnc) to Go, because the toolchain has no RELAX NG validator. It checks
// element cardinality, permitted attributes and namespaces, atomUri/media type/language/
// date datatypes, opds:price rules, and summary type, plus the OPDS catalog requirements
// for navigation and acquisition entries.

const xmlNamespace = "http://www.w3.org/XML/1998/namespace"

var (
	mediaTypePattern = regexp.MustCompile(`^.+/.+$`)
	languagePattern  = regexp.MustCompile(`^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$`)
	ncNamePattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.\-]*$`)
	opdsPriceRels    = map[string]bool{
		"http://opds-spec.org/acquisition/borrow":    true,
		"http://opds-spec.org/acquisition/subscribe": true,
		"http://opds-spec.org/acquisition/sample":    true,
		"preview": true,
	}
)

type xmlNode struct {
	Name     xml.Name
	Attrs    []xml.Attr
	Children []*xmlNode
	Text     string
}

func parseXMLTree(data []byte) (*xmlNode, error) {
	decoder := xml.NewDecoder(strings.NewReader(string(data)))
	var stack []*xmlNode
	var root *xmlNode
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			node := &xmlNode{Name: value.Name}
			for _, attr := range value.Attr {
				if attr.Name.Space == "xmlns" || attr.Name.Space == "" && attr.Name.Local == "xmlns" {
					continue
				}
				node.Attrs = append(node.Attrs, attr)
			}
			if len(stack) == 0 {
				if root != nil {
					return nil, fmt.Errorf("multiple root elements")
				}
				root = node
			} else {
				parent := stack[len(stack)-1]
				parent.Children = append(parent.Children, node)
			}
			stack = append(stack, node)
		case xml.EndElement:
			stack = stack[:len(stack)-1]
		case xml.CharData:
			if len(stack) > 0 {
				stack[len(stack)-1].Text += string(value)
			}
		}
	}
	if root == nil {
		return nil, fmt.Errorf("document has no root element")
	}
	return root, nil
}

func (n *xmlNode) attr(local string) (string, bool) {
	for _, attr := range n.Attrs {
		if attr.Name.Space == "" && attr.Name.Local == local {
			return attr.Value, true
		}
	}
	return "", false
}

func (n *xmlNode) atom(local string) []*xmlNode {
	var result []*xmlNode
	for _, child := range n.Children {
		if child.Name.Space == atomNamespace && child.Name.Local == local {
			result = append(result, child)
		}
	}
	return result
}

type schemaErrors []string

func (e *schemaErrors) add(path, format string, args ...any) {
	*e = append(*e, path+": "+fmt.Sprintf(format, args...))
}

func validAtomURI(value string) bool {
	if value == "" || strings.ContainsAny(value, " <>{}|^`\"\n\r\t") {
		return false
	}
	_, err := url.Parse(value)
	return err == nil
}

func (e *schemaErrors) attributes(path string, node *xmlNode, allowed ...string) {
	permitted := map[string]bool{}
	for _, name := range allowed {
		permitted[name] = true
	}
	for _, attr := range node.Attrs {
		switch {
		case attr.Name.Space == "" && permitted[attr.Name.Local]:
		case attr.Name.Space == xmlNamespace && (attr.Name.Local == "base" || attr.Name.Local == "lang"):
		case attr.Name.Space == opdsNamespace:
		default:
			e.add(path, "undefined attribute {%s}%s", attr.Name.Space, attr.Name.Local)
		}
	}
}

func (e *schemaErrors) children(path string, node *xmlNode, once, optional, many []string) {
	counts := map[string]int{}
	known := map[string]bool{}
	for _, list := range [][]string{once, optional, many} {
		for _, name := range list {
			known[name] = true
		}
	}
	for _, child := range node.Children {
		switch child.Name.Space {
		case atomNamespace:
			if !known[child.Name.Local] {
				e.add(path, "unexpected atom:%s", child.Name.Local)
			}
			counts[child.Name.Local]++
		case "":
			e.add(path, "element %s has no namespace", child.Name.Local)
		}
	}
	for _, name := range once {
		if counts[name] != 1 {
			e.add(path, "atom:%s occurs %d times, want exactly 1", name, counts[name])
		}
	}
	for _, name := range optional {
		if counts[name] > 1 {
			e.add(path, "atom:%s occurs %d times, want at most 1", name, counts[name])
		}
	}
}

func (e *schemaErrors) text(path string, node *xmlNode, summary bool) {
	e.attributes(path, node, "type")
	kind, ok := node.attr("type")
	if !ok {
		return
	}
	if summary && kind != "text" || !summary && kind != "text" && kind != "html" && kind != "xhtml" {
		e.add(path, "invalid text construct type %q", kind)
	}
}

func (e *schemaErrors) date(path string, node *xmlNode) {
	e.attributes(path, node)
	if _, err := time.Parse(time.RFC3339, strings.TrimSpace(node.Text)); err != nil {
		e.add(path, "invalid date %q", node.Text)
	}
}

func (e *schemaErrors) person(path string, node *xmlNode) {
	e.attributes(path, node)
	e.children(path, node, []string{"name"}, []string{"uri", "email"}, nil)
}

func (e *schemaErrors) link(path string, node *xmlNode) {
	e.attributes(path, node, "href", "rel", "type", "hreflang", "title", "length")
	href, ok := node.attr("href")
	if !ok || !validAtomURI(href) {
		e.add(path, "invalid href %q", href)
	}
	if kind, ok := node.attr("type"); ok && !mediaTypePattern.MatchString(kind) {
		e.add(path, "invalid media type %q", kind)
	}
	if lang, ok := node.attr("hreflang"); ok && !languagePattern.MatchString(lang) {
		e.add(path, "invalid hreflang %q", lang)
	}
	rel, hasRel := node.attr("rel")
	if hasRel && !ncNamePattern.MatchString(rel) && !validAtomURI(rel) {
		e.add(path, "invalid rel %q", rel)
	}
	prices := 0
	for _, child := range node.Children {
		if child.Name.Space == opdsNamespace && child.Name.Local == "price" {
			prices++
		} else if child.Name.Space == atomNamespace || child.Name.Space == opdsNamespace && child.Name.Local != "indirectAcquisition" {
			e.add(path, "unexpected link child {%s}%s", child.Name.Space, child.Name.Local)
		}
	}
	switch {
	case rel == "http://opds-spec.org/acquisition/buy" && prices == 0:
		e.add(path, "buy link requires opds:price")
	case rel != "http://opds-spec.org/acquisition/buy" && !opdsPriceRels[rel] && prices > 0:
		e.add(path, "rel %q does not permit opds:price", rel)
	}
}

func (e *schemaErrors) common(path string, node *xmlNode) {
	for _, child := range node.atom("id") {
		e.attributes(path+"/id", child)
		if parsed, err := url.Parse(strings.TrimSpace(child.Text)); err != nil || !validAtomURI(strings.TrimSpace(child.Text)) || parsed.Scheme == "" {
			e.add(path+"/id", "invalid IRI %q", child.Text)
		}
	}
	for _, name := range []string{"title", "subtitle", "rights"} {
		for _, child := range node.atom(name) {
			e.text(path+"/"+name, child, false)
		}
	}
	for _, name := range []string{"updated", "published"} {
		for _, child := range node.atom(name) {
			e.date(path+"/"+name, child)
		}
	}
	for _, name := range []string{"author", "contributor"} {
		for _, child := range node.atom(name) {
			e.person(path+"/"+name, child)
		}
	}
	for _, child := range node.atom("category") {
		e.attributes(path+"/category", child, "term", "scheme", "label")
		if term, ok := child.attr("term"); !ok || term == "" {
			e.add(path+"/category", "missing term")
		}
	}
	for index, child := range node.atom("link") {
		e.link(fmt.Sprintf("%s/link[%d]", path, index+1), child)
	}
}

func hasCatalogLink(node *xmlNode) bool {
	for _, link := range node.atom("link") {
		if kind, _ := link.attr("type"); strings.HasPrefix(kind, "application/atom+xml") && strings.Contains(kind, "profile=opds-catalog") {
			return true
		}
	}
	return false
}

func hasAcquisitionLink(node *xmlNode) bool {
	for _, link := range node.atom("link") {
		if rel, _ := link.attr("rel"); strings.HasPrefix(rel, "http://opds-spec.org/acquisition") {
			return true
		}
	}
	return false
}

// validateOPDSFeed validates a feed document; kind is "navigation" or "acquisition".
func validateOPDSFeed(data []byte, kind string) error {
	root, err := parseXMLTree(data)
	if err != nil {
		return fmt.Errorf("feed is not well-formed XML: %w", err)
	}
	var errs schemaErrors
	if root.Name.Space != atomNamespace || root.Name.Local != "feed" {
		return fmt.Errorf("root element is {%s}%s, want atom:feed", root.Name.Space, root.Name.Local)
	}
	errs.attributes("feed", root)
	errs.children("feed", root, []string{"id", "title", "updated"},
		[]string{"generator", "icon", "logo", "rights", "subtitle"},
		[]string{"author", "category", "contributor", "link", "entry"})
	errs.common("feed", root)
	hasSelf := false
	for _, link := range root.atom("link") {
		if rel, _ := link.attr("rel"); rel == "self" {
			hasSelf = true
		}
	}
	if !hasSelf {
		errs.add("feed", "missing rel=self link")
	}
	feedAuthor := len(root.atom("author")) > 0
	for index, entry := range root.atom("entry") {
		path := fmt.Sprintf("feed/entry[%d]", index+1)
		errs.attributes(path, entry)
		errs.children(path, entry, []string{"id", "title", "updated"},
			[]string{"content", "published", "rights", "source", "summary"},
			[]string{"author", "category", "contributor", "link"})
		errs.common(path, entry)
		for _, summary := range entry.atom("summary") {
			errs.text(path+"/summary", summary, true)
		}
		for _, content := range entry.atom("content") {
			errs.attributes(path+"/content", content, "type", "src")
		}
		if !feedAuthor && len(entry.atom("author")) == 0 {
			errs.add(path, "entry has no author and the feed has none")
		}
		switch kind {
		case "navigation":
			if len(entry.atom("content")) != 1 || !hasCatalogLink(entry) {
				errs.add(path, "navigation entry needs content and a catalog link")
			}
		case "acquisition":
			if !hasAcquisitionLink(entry) {
				errs.add(path, "acquisition entry has no acquisition link")
			}
		default:
			return fmt.Errorf("unknown feed kind %q", kind)
		}
	}
	if len(errs) > 0 {
		return fmt.Errorf("OPDS schema violations:\n%s", strings.Join(errs, "\n"))
	}
	return nil
}

func validateOpenSearch(data []byte) error {
	root, err := parseXMLTree(data)
	if err != nil {
		return err
	}
	if root.Name.Space != openSearchNamespace || root.Name.Local != "OpenSearchDescription" {
		return fmt.Errorf("root element is {%s}%s", root.Name.Space, root.Name.Local)
	}
	found := map[string]*xmlNode{}
	for _, child := range root.Children {
		if child.Name.Space != openSearchNamespace {
			return fmt.Errorf("unexpected element {%s}%s", child.Name.Space, child.Name.Local)
		}
		found[child.Name.Local] = child
	}
	if name := found["ShortName"]; name == nil || len(name.Text) == 0 || len(name.Text) > 16 {
		return fmt.Errorf("ShortName is missing or longer than 16 characters")
	}
	if description := found["Description"]; description == nil || len(description.Text) > 1024 {
		return fmt.Errorf("Description is missing or too long")
	}
	link := found["Url"]
	if link == nil {
		return fmt.Errorf("missing Url")
	}
	template, _ := link.attr("template")
	kind, _ := link.attr("type")
	if !strings.Contains(template, "{searchTerms}") || !mediaTypePattern.MatchString(kind) {
		return fmt.Errorf("invalid Url template %q or type %q", template, kind)
	}
	return nil
}
