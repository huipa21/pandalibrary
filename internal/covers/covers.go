// Package covers decodes and normalizes ebook covers for content-addressed storage.
// Transparent pixels are composited onto white; generated JPEGs are never upscaled.
package covers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	MaxInputBytes  = 20 << 20
	MaxInputPixels = 20_000_000
	MaxFullEdge    = 1200
	ThumbnailEdge  = 400
)

var (
	ErrInvalidImage  = errors.New("invalid cover image")
	ErrImageTooLarge = errors.New("cover image exceeds safety limits")
)

type Result struct {
	FullJPEG        []byte
	ThumbnailJPEG   []byte
	FullSHA256      string
	ThumbnailSHA256 string
	Width           int
	Height          int
	ThumbnailWidth  int
	ThumbnailHeight int
}

func Normalize(encoded []byte) (Result, error) {
	if len(encoded) == 0 {
		return Result{}, fmt.Errorf("%w: image is empty", ErrInvalidImage)
	}
	if len(encoded) > MaxInputBytes {
		return Result{}, fmt.Errorf("%w: encoded image is %d bytes", ErrImageTooLarge, len(encoded))
	}

	config, format, err := image.DecodeConfig(bytes.NewReader(encoded))
	if err != nil {
		return Result{}, fmt.Errorf("%w: decode image header: %v", ErrInvalidImage, err)
	}
	if config.Width <= 0 || config.Height <= 0 {
		return Result{}, fmt.Errorf("%w: image dimensions are invalid", ErrInvalidImage)
	}
	if int64(config.Width) > int64(MaxInputPixels)/int64(config.Height) {
		return Result{}, fmt.Errorf("%w: image dimensions are %dx%d", ErrImageTooLarge, config.Width, config.Height)
	}
	if format != "jpeg" && format != "png" && format != "gif" && format != "webp" {
		return Result{}, fmt.Errorf("%w: unsupported image format %q", ErrInvalidImage, format)
	}

	source, _, err := image.Decode(bytes.NewReader(encoded))
	if err != nil {
		return Result{}, fmt.Errorf("%w: decode image: %v", ErrInvalidImage, err)
	}
	fullWidth, fullHeight := fit(source.Bounds().Dx(), source.Bounds().Dy(), MaxFullEdge)
	thumbWidth, thumbHeight := fit(source.Bounds().Dx(), source.Bounds().Dy(), ThumbnailEdge)
	full, err := encodeJPEG(source, fullWidth, fullHeight)
	if err != nil {
		return Result{}, err
	}
	thumbnail, err := encodeJPEG(source, thumbWidth, thumbHeight)
	if err != nil {
		return Result{}, err
	}
	return Result{
		FullJPEG:        full,
		ThumbnailJPEG:   thumbnail,
		FullSHA256:      digest(full),
		ThumbnailSHA256: digest(thumbnail),
		Width:           fullWidth,
		Height:          fullHeight,
		ThumbnailWidth:  thumbWidth,
		ThumbnailHeight: thumbHeight,
	}, nil
}

func fit(width, height, maxEdge int) (int, int) {
	longest := max(width, height)
	if longest <= maxEdge {
		return width, height
	}
	scale := float64(maxEdge) / float64(longest)
	return max(1, int(float64(width)*scale+0.5)), max(1, int(float64(height)*scale+0.5))
}

func encodeJPEG(source image.Image, width, height int) ([]byte, error) {
	scaled := image.NewNRGBA(image.Rect(0, 0, width, height))
	xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), source, source.Bounds(), xdraw.Src, nil)

	opaque := image.NewRGBA(scaled.Bounds())
	draw.Draw(opaque, opaque.Bounds(), &image.Uniform{C: color.White}, image.Point{}, draw.Src)
	draw.Draw(opaque, opaque.Bounds(), scaled, scaled.Bounds().Min, draw.Over)

	var output bytes.Buffer
	if err := jpeg.Encode(&output, opaque, &jpeg.Options{Quality: 85}); err != nil {
		return nil, fmt.Errorf("encode normalized cover: %w", err)
	}
	return output.Bytes(), nil
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
