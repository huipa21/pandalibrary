package fb2

import (
	"context"
	"encoding/base64"
	"encoding/xml"
	"fmt"
	"io"

	"pandalibrary/internal/extract"
)

func readCover(ctx context.Context, input io.Reader, coverID string) ([]byte, error) {
	decoder := xmlDecoder(ctx, input)
	depth := 0
	found := false
	inCover := false
	var cover coverDecoder
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("%w: parse FB2 cover: %v", extract.ErrInvalidInput, err)
		}
		switch token := token.(type) {
		case xml.StartElement:
			depth++
			if inCover {
				return nil, fmt.Errorf("%w: nested FB2 cover binary content", extract.ErrInvalidInput)
			}
			if depth == 2 && token.Name.Local == "binary" && attribute(token, "id") == coverID {
				if found {
					return nil, fmt.Errorf("%w: duplicate FB2 cover binary", extract.ErrInvalidInput)
				}
				found = true
				inCover = true
			}
		case xml.EndElement:
			if inCover && depth == 2 {
				if err := cover.finish(); err != nil {
					return nil, err
				}
				inCover = false
			}
			depth--
		case xml.CharData:
			if inCover {
				if err := cover.write(ctx, token); err != nil {
					return nil, err
				}
			}
		case xml.Directive:
			return nil, fmt.Errorf("%w: XML directives are not accepted", extract.ErrInvalidInput)
		}
	}
	if !found {
		return nil, fmt.Errorf("%w: FB2 cover binary %q was not found", extract.ErrInvalidInput, coverID)
	}
	return cover.data, nil
}

type coverDecoder struct {
	data     []byte
	quartet  [4]byte
	count    int
	finished bool
}

func (d *coverDecoder) write(ctx context.Context, encoded []byte) error {
	for i, b := range encoded {
		if i&0xffff == 0 {
			if err := ctx.Err(); err != nil {
				return err
			}
		}
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		}
		if d.finished {
			return fmt.Errorf("%w: data after FB2 cover base64 padding", extract.ErrInvalidInput)
		}
		d.quartet[d.count] = b
		d.count++
		if d.count != len(d.quartet) {
			continue
		}
		var decoded [3]byte
		n, err := base64.StdEncoding.Strict().Decode(decoded[:], d.quartet[:])
		if err != nil {
			return fmt.Errorf("%w: invalid FB2 cover base64: %v", extract.ErrInvalidInput, err)
		}
		if len(d.data) > extract.MaxCoverEntrySize-n {
			return fmt.Errorf("%w: FB2 cover exceeds its decoded size limit", extract.ErrTooLarge)
		}
		d.data = append(d.data, decoded[:n]...)
		d.finished = d.quartet[2] == '=' || d.quartet[3] == '='
		d.count = 0
	}
	return nil
}

func (d *coverDecoder) finish() error {
	if d.count != 0 || len(d.data) == 0 {
		return fmt.Errorf("%w: incomplete or empty FB2 cover base64", extract.ErrInvalidInput)
	}
	return nil
}
