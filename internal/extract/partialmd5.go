package extract

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"io"
)

const (
	PartialMD5SampleSize = 1024
	PartialMD5MaxSamples = 12
)

func PartialMD5(r io.ReaderAt, size int64) (string, error) {
	if r == nil || size < 0 {
		return "", fmt.Errorf("%w: invalid reader or size", ErrInvalidInput)
	}
	hash := md5.New()
	for sample := 0; sample < PartialMD5MaxSamples; sample++ {
		offset := int64(0)
		if sample > 0 {
			offset = int64(PartialMD5SampleSize) << (2 * (sample - 1))
		}
		if offset >= size {
			break
		}
		readSize := min(int64(PartialMD5SampleSize), size-offset)
		buffer := make([]byte, int(readSize))
		n, err := r.ReadAt(buffer, offset)
		if err != nil && !(err == io.EOF && int64(n) == readSize) {
			return "", fmt.Errorf("read partial-MD5 sample at offset %d: %w", offset, err)
		}
		if int64(n) != readSize {
			return "", fmt.Errorf("read partial-MD5 sample at offset %d: %w", offset, io.ErrUnexpectedEOF)
		}
		if _, err := hash.Write(buffer); err != nil {
			return "", fmt.Errorf("hash partial-MD5 sample: %w", err)
		}
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
