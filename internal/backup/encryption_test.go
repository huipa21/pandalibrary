package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
)

func TestValidatePassphrase(t *testing.T) {
	tests := []struct {
		name       string
		passphrase string
		wantErr    bool
	}{
		{name: "empty", passphrase: "", wantErr: true},
		{name: "too short", passphrase: "12345678901", wantErr: true},
		{name: "minimum", passphrase: "123456789012"},
		{name: "maximum", passphrase: strings.Repeat("a", MaxPassphraseBytes)},
		{name: "too long", passphrase: strings.Repeat("a", MaxPassphraseBytes+1), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := ValidatePassphrase(test.passphrase)
			if (err != nil) != test.wantErr {
				t.Fatalf("ValidatePassphrase() error = %v, wantErr %v", err, test.wantErr)
			}
			if test.wantErr && !errors.Is(err, ErrPassphrase) {
				t.Fatalf("ValidatePassphrase() error = %v, want ErrPassphrase", err)
			}
		})
	}
}

func TestEncryptedBackupRequiresCorrectPassphrase(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	info, err := s.Create(ctx, testPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := s.Open(info.Name)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(archive)
	closeErr := archive.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		t.Fatal(err)
	}
	if err := s.Stage(ctx, bytes.NewReader(data), "this is the wrong passphrase"); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("wrong passphrase error = %v, want ErrPassphrase", err)
	}
	if s.Pending() {
		t.Fatal("wrong passphrase staged a restore")
	}
	if err := s.Stage(ctx, bytes.NewReader(data), testPassphrase); err != nil {
		t.Fatal(err)
	}
	if !s.Pending() {
		t.Fatal("correct passphrase did not stage a restore")
	}
}

func TestLegacyPlaintextBackupStages(t *testing.T) {
	s, _ := fixture(t)
	ctx := context.Background()
	info, err := s.Create(ctx, testPassphrase)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := s.Open(info.Name)
	if err != nil {
		t.Fatal(err)
	}
	decrypted, encrypted, err := decryptReader(archive, testPassphrase)
	if err != nil {
		archive.Close()
		t.Fatal(err)
	}
	if !encrypted {
		archive.Close()
		t.Fatal("new backup is not encrypted")
	}
	plain, readErr := io.ReadAll(decrypted)
	closeErr := archive.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		t.Fatal(err)
	}
	if err := s.Stage(ctx, bytes.NewReader(plain), ""); err != nil {
		t.Fatal(err)
	}
	if !s.Pending() {
		t.Fatal("legacy plaintext archive was not staged")
	}
}

func TestCreateRejectsWeakPassphrase(t *testing.T) {
	s, _ := fixture(t)
	if _, err := s.Create(context.Background(), "too short"); !errors.Is(err, ErrPassphrase) {
		t.Fatalf("Create() error = %v, want ErrPassphrase", err)
	}
}
