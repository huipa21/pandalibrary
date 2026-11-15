package wordbooks

import (
	"bytes"
	"encoding/base64"
	"image/jpeg"
	"strings"
)

const (
	// Covers are cropped and compressed by the client before upload.
	MaxCoverImageBytes = 600 * 1024
	coverImagePrefix   = "data:image/jpeg;base64,"
)

// Empty color and image select the automatic palette and generated cover.
func validateCover(color, image string) error {
	switch color {
	case "", "navy", "forest", "ochre", "khaki", "rust", "taupe", "burgundy", "slate-teal":
	default:
		return invalid("cover_color must be empty or a supported palette color")
	}
	if image == "" {
		return nil
	}
	if !strings.HasPrefix(image, coverImagePrefix) {
		return invalid("cover_image must be a data:image/jpeg;base64 URL")
	}
	encoded := strings.TrimPrefix(image, coverImagePrefix)
	if len(encoded) > base64.StdEncoding.EncodedLen(MaxCoverImageBytes) {
		return invalid("cover_image must not exceed 600 KiB decoded")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(data) == 0 || base64.StdEncoding.EncodeToString(data) != encoded {
		return invalid("cover_image must contain valid standard base64")
	}
	if len(data) > MaxCoverImageBytes {
		return invalid("cover_image must not exceed 600 KiB decoded")
	}
	// Inspect dimensions before decoding pixels to bound image allocations.
	config, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width != 600 || config.Height != 900 {
		return invalid("cover_image must be a JPEG exactly 600x900 pixels")
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return invalid("cover_image must contain a complete valid JPEG")
	}
	return nil
}
