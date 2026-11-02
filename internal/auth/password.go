package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/argon2"
)

const (
	passwordMemoryKiB = 64 * 1024
	passwordTime      = 3
	passwordThreads   = 4
	passwordSaltBytes = 16
	passwordKeyBytes  = 32
	maxPasswordBytes  = 1024
)

type passwordManager struct {
	slots chan struct{}
}

func newPasswordManager() *passwordManager {
	return &passwordManager{slots: make(chan struct{}, 2)}
}

func (p *passwordManager) acquire(ctx context.Context) error {
	select {
	case p.slots <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *passwordManager) release() {
	<-p.slots
}

func (p *passwordManager) hash(ctx context.Context, password string) (string, error) {
	if err := validatePassword(password); err != nil {
		return "", err
	}
	if err := p.acquire(ctx); err != nil {
		return "", err
	}
	defer p.release()

	salt := make([]byte, passwordSaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, passwordTime, passwordMemoryKiB, passwordThreads, passwordKeyBytes)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		passwordMemoryKiB, passwordTime, passwordThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key)), nil
}

func (p *passwordManager) verify(ctx context.Context, password, encoded string) (bool, error) {
	parsed, err := parsePasswordHash(encoded)
	if err != nil {
		return false, err
	}
	if err := p.acquire(ctx); err != nil {
		return false, err
	}
	defer p.release()

	key := argon2.IDKey([]byte(password), parsed.salt, parsed.time, parsed.memory, parsed.threads, uint32(len(parsed.key)))
	return subtle.ConstantTimeCompare(key, parsed.key) == 1, nil
}

func (p *passwordManager) needsRehash(encoded string) bool {
	parsed, err := parsePasswordHash(encoded)
	if err != nil {
		return true
	}
	return parsed.memory != passwordMemoryKiB || parsed.time != passwordTime ||
		parsed.threads != passwordThreads || len(parsed.salt) != passwordSaltBytes ||
		len(parsed.key) != passwordKeyBytes
}

func validatePassword(password string) error {
	if !utf8.ValidString(password) {
		return errors.New("password must be valid UTF-8")
	}
	if len(password) < 12 {
		return errors.New("password must be at least 12 bytes")
	}
	if len(password) > maxPasswordBytes {
		return fmt.Errorf("password must not exceed %d bytes", maxPasswordBytes)
	}
	return nil
}

type parsedPasswordHash struct {
	memory  uint32
	time    uint32
	threads uint8
	salt    []byte
	key     []byte
}

func parsePasswordHash(encoded string) (parsedPasswordHash, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" {
		return parsedPasswordHash{}, errors.New("invalid argon2id password hash")
	}
	params := make(map[string]uint64, 3)
	for _, entry := range strings.Split(parts[3], ",") {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			return parsedPasswordHash{}, errors.New("invalid argon2id parameters")
		}
		parsed, err := strconv.ParseUint(value, 10, 32)
		if err != nil {
			return parsedPasswordHash{}, errors.New("invalid argon2id parameters")
		}
		params[key] = parsed
	}
	memory, timeCost, threads := params["m"], params["t"], params["p"]
	if len(params) != 3 || memory < 8*1024 || memory > 256*1024 ||
		timeCost == 0 || timeCost > 10 || threads == 0 || threads > 16 {
		return parsedPasswordHash{}, errors.New("argon2id parameters are outside supported limits")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) < passwordSaltBytes {
		return parsedPasswordHash{}, errors.New("invalid argon2id salt")
	}
	key, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(key) < 16 || len(key) > 64 {
		return parsedPasswordHash{}, errors.New("invalid argon2id key")
	}
	return parsedPasswordHash{
		memory: uint32(memory), time: uint32(timeCost), threads: uint8(threads), salt: salt, key: key,
	}, nil
}
