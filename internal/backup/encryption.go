package backup

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode/utf8"

	"filippo.io/age"
)

const (
	// MinPassphraseRunes is the minimum passphrase length accepted for new backups.
	MinPassphraseRunes = 12
	// MaxPassphraseBytes bounds passphrase input before it is sent to age.
	MaxPassphraseBytes = 1024
	// EncryptedSuffix identifies a passphrase-encrypted full-data backup.
	EncryptedSuffix = ".tar.gz.age"
)

const ageHeader = "age-encryption.org/v1\n"

// ErrPassphrase means the backup passphrase is missing, too weak, or incorrect.
var ErrPassphrase = errors.New("backup passphrase is missing, too short, or incorrect")

// ValidatePassphrase checks a passphrase intended for a new backup.
func ValidatePassphrase(passphrase string) error {
	if passphrase == "" {
		return ErrPassphrase
	}
	if len(passphrase) > MaxPassphraseBytes {
		return fmt.Errorf("%w: passphrase is too long", ErrPassphrase)
	}
	if utf8.RuneCountInString(passphrase) < MinPassphraseRunes {
		return fmt.Errorf("%w: use at least %d characters", ErrPassphrase, MinPassphraseRunes)
	}
	return nil
}

func encryptArchive(dst io.Writer, passphrase string) (io.WriteCloser, error) {
	if err := ValidatePassphrase(passphrase); err != nil {
		return nil, err
	}
	recipient, err := age.NewScryptRecipient(passphrase)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrPassphrase, err)
	}
	writer, err := age.Encrypt(dst, recipient)
	if err != nil {
		return nil, fmt.Errorf("encrypt backup: %w", err)
	}
	return writer, nil
}

// decryptReader detects the age header and decrypts the stream. A plaintext
// stream is returned unchanged so legacy .tar.gz backups remain restorable.
func decryptReader(src io.Reader, passphrase string) (io.Reader, bool, error) {
	buffered := bufio.NewReader(src)
	header, err := buffered.Peek(len(ageHeader))
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, false, err
	}
	if string(header) != ageHeader {
		return buffered, false, nil
	}
	if passphrase == "" {
		return nil, true, ErrPassphrase
	}
	identity, err := age.NewScryptIdentity(passphrase)
	if err != nil {
		return nil, true, fmt.Errorf("%w: %v", ErrPassphrase, err)
	}
	decrypted, err := age.Decrypt(buffered, identity)
	if err != nil {
		var noMatch *age.NoIdentityMatchError
		if errors.As(err, &noMatch) {
			return nil, true, fmt.Errorf("%w: wrong passphrase", ErrPassphrase)
		}
		return nil, true, fmt.Errorf("%w: decrypt: %v", ErrInvalid, err)
	}
	return decrypted, true, nil
}

// IsEncryptedFile reports whether filename starts with the age file header.
// It is used by the CLI to decide whether to prompt for a passphrase.
func IsEncryptedFile(filename string) (bool, error) {
	file, err := os.Open(filename)
	if err != nil {
		return false, err
	}
	defer file.Close()
	header := make([]byte, len(ageHeader))
	n, err := io.ReadFull(file, header)
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return bytes.Equal(header[:n], []byte(ageHeader)), nil
}

func encryptedName(name string) bool {
	return strings.HasSuffix(name, EncryptedSuffix)
}
