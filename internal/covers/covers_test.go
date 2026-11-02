package covers

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

func TestNormalizeResizesAndHashesJPEGOutputs(t *testing.T) {
	input := image.NewNRGBA(image.Rect(0, 0, 1600, 800))
	for y := 0; y < 800; y++ {
		for x := 0; x < 1600; x++ {
			if x >= 200 || y >= 200 {
				input.SetNRGBA(x, y, color.NRGBA{R: 40, G: 90, B: 150, A: 255})
			}
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, input); err != nil {
		t.Fatal(err)
	}

	result, err := Normalize(encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if result.Width != 1200 || result.Height != 600 {
		t.Fatalf("full dimensions = %dx%d, want 1200x600", result.Width, result.Height)
	}
	if result.ThumbnailWidth != 400 || result.ThumbnailHeight != 200 {
		t.Fatalf("thumbnail dimensions = %dx%d, want 400x200", result.ThumbnailWidth, result.ThumbnailHeight)
	}
	for _, output := range [][]byte{result.FullJPEG, result.ThumbnailJPEG} {
		config, format, err := image.DecodeConfig(bytes.NewReader(output))
		if err != nil {
			t.Fatal(err)
		}
		if format != "jpeg" || config.Width > MaxFullEdge || config.Height > MaxFullEdge {
			t.Fatalf("output format/dimensions = %s %dx%d", format, config.Width, config.Height)
		}
	}
	fullHash := sha256.Sum256(result.FullJPEG)
	thumbHash := sha256.Sum256(result.ThumbnailJPEG)
	if result.FullSHA256 != hex.EncodeToString(fullHash[:]) ||
		result.ThumbnailSHA256 != hex.EncodeToString(thumbHash[:]) {
		t.Fatal("output hashes do not match encoded JPEG bytes")
	}

	decoded, err := jpeg.Decode(bytes.NewReader(result.FullJPEG))
	if err != nil {
		t.Fatal(err)
	}
	if got := color.RGBAModel.Convert(decoded.At(0, 0)).(color.RGBA); got.R < 245 || got.G < 245 || got.B < 245 {
		t.Fatalf("transparent pixel background = %#v, want white", got)
	}
}

func TestNormalizeRejectsInvalidAndOversizedInputs(t *testing.T) {
	if _, err := Normalize([]byte("not an image")); err == nil {
		t.Fatal("Normalize() accepted invalid image data")
	}
	large := make([]byte, MaxInputBytes+1)
	if _, err := Normalize(large); err == nil {
		t.Fatal("Normalize() accepted an oversized image")
	}
}

func TestNormalizeRejectsExcessiveImageDimensions(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 1, 1))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, small); err != nil {
		t.Fatal(err)
	}
	data := encoded.Bytes()
	binary.BigEndian.PutUint32(data[16:20], 50_000)
	binary.BigEndian.PutUint32(data[20:24], 50_000)
	binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))

	if _, err := Normalize(data); !errors.Is(err, ErrImageTooLarge) {
		t.Fatalf("Normalize() error = %v, want oversized dimensions", err)
	}
}

func TestNormalizeDoesNotUpscale(t *testing.T) {
	small := image.NewRGBA(image.Rect(0, 0, 40, 20))
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, small); err != nil {
		t.Fatal(err)
	}
	result, err := Normalize(encoded.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	if result.Width != 40 || result.Height != 20 || result.ThumbnailWidth != 40 || result.ThumbnailHeight != 20 {
		t.Fatalf("small image was upscaled: full %dx%d, thumbnail %dx%d",
			result.Width, result.Height, result.ThumbnailWidth, result.ThumbnailHeight)
	}
}
