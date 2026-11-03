package opds

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"time"
)

const (
	atomNamespace       = "http://www.w3.org/2005/Atom"
	opdsNamespace       = "http://opds-spec.org/2010/catalog"
	dcNamespace         = "http://purl.org/dc/terms/"
	openSearchNamespace = "http://a9.com/-/spec/opensearch/1.1/"

	// NavigationType is the media type of OPDS navigation feeds.
	NavigationType = "application/atom+xml;profile=opds-catalog;kind=navigation"
	// AcquisitionType is the media type of OPDS acquisition feeds.
	AcquisitionType = "application/atom+xml;profile=opds-catalog;kind=acquisition"
	// OpenSearchType is the media type of the OpenSearch description document.
	OpenSearchType = "application/opensearchdescription+xml"

	relAcquisition = "http://opds-spec.org/acquisition"
	relImage       = "http://opds-spec.org/image"
	relThumbnail   = "http://opds-spec.org/image/thumbnail"
	relSortNew     = "http://opds-spec.org/sort/new"
)

type feed struct {
	XMLName     xml.Name `xml:"feed"`
	Namespace   string   `xml:"xmlns,attr"`
	DCNamespace string   `xml:"xmlns:dc,attr"`
	OPDS        string   `xml:"xmlns:opds,attr"`
	ID          string   `xml:"id"`
	Title       string   `xml:"title"`
	Updated     string   `xml:"updated"`
	Author      person   `xml:"author"`
	Links       []link   `xml:"link"`
	Entries     []entry  `xml:"entry"`
}

type person struct {
	Name string `xml:"name"`
}

type link struct {
	Rel    string `xml:"rel,attr,omitempty"`
	Href   string `xml:"href,attr"`
	Type   string `xml:"type,attr,omitempty"`
	Title  string `xml:"title,attr,omitempty"`
	Length int64  `xml:"length,attr,omitempty"`
}

type textConstruct struct {
	Type  string `xml:"type,attr"`
	Value string `xml:",chardata"`
}

type category struct {
	Term  string `xml:"term,attr"`
	Label string `xml:"label,attr,omitempty"`
}

type entry struct {
	Title        string         `xml:"title"`
	ID           string         `xml:"id"`
	Updated      string         `xml:"updated"`
	Authors      []person       `xml:"author"`
	Contributors []person       `xml:"contributor"`
	Language     string         `xml:"dc:language,omitempty"`
	Publisher    string         `xml:"dc:publisher,omitempty"`
	Issued       string         `xml:"dc:issued,omitempty"`
	Identifiers  []string       `xml:"dc:identifier"`
	Categories   []category     `xml:"category"`
	Summary      *textConstruct `xml:"summary"`
	Content      *textConstruct `xml:"content"`
	Links        []link         `xml:"link"`
}

type openSearchDescription struct {
	XMLName        xml.Name      `xml:"OpenSearchDescription"`
	Namespace      string        `xml:"xmlns,attr"`
	ShortName      string        `xml:"ShortName"`
	Description    string        `xml:"Description"`
	InputEncoding  string        `xml:"InputEncoding"`
	OutputEncoding string        `xml:"OutputEncoding"`
	URL            openSearchURL `xml:"Url"`
}

type openSearchURL struct {
	Type     string `xml:"type,attr"`
	Template string `xml:"template,attr"`
}

func newFeed(id, title string, updated time.Time) feed {
	return feed{
		Namespace: atomNamespace, DCNamespace: dcNamespace, OPDS: opdsNamespace,
		ID: id, Title: title, Updated: atomTime(updated), Author: person{Name: "PandaLibrary"},
	}
}

func atomTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339)
}

// encodeXML serializes a document. encoding/xml escapes markup and replaces characters
// that XML 1.0 cannot represent, so catalog metadata cannot break the document.
func encodeXML(document any) ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteString(xml.Header)
	encoder := xml.NewEncoder(&buffer)
	encoder.Indent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return nil, fmt.Errorf("encode OPDS document: %w", err)
	}
	if err := encoder.Close(); err != nil {
		return nil, fmt.Errorf("finish OPDS document: %w", err)
	}
	buffer.WriteByte('\n')
	return buffer.Bytes(), nil
}
