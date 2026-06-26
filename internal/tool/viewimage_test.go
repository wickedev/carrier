package tool

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

// a minimal valid 1x1 PNG.
var onePixelPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func TestViewImageReadsPNG(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "pic.png"), onePixelPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := NewViewImage().Exec(context.Background(),
		map[string]any{"path": "pic.png"}, ExecContext{Cwd: dir})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error result: %s", res.Content)
	}
	if len(res.Images) != 1 {
		t.Fatalf("expected 1 image, got %d", len(res.Images))
	}
	img := res.Images[0]
	if img.MediaType != "image/png" {
		t.Errorf("media type = %q, want image/png", img.MediaType)
	}
	decoded, err := base64.StdEncoding.DecodeString(img.Base64)
	if err != nil || len(decoded) != len(onePixelPNG) {
		t.Errorf("base64 did not round-trip: err=%v len=%d", err, len(decoded))
	}
}

func TestViewImageRejectsNonImage(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("just text, not an image"), 0o644)
	res, _ := NewViewImage().Exec(context.Background(),
		map[string]any{"path": "notes.txt"}, ExecContext{Cwd: dir})
	if !res.IsError {
		t.Fatal("expected error for a non-image file")
	}
	if len(res.Images) != 0 {
		t.Fatal("non-image must not attach an image")
	}
}

func TestViewImageMissingAndDir(t *testing.T) {
	dir := t.TempDir()
	if r, _ := NewViewImage().Exec(context.Background(), map[string]any{}, ExecContext{Cwd: dir}); !r.IsError {
		t.Error("expected error for missing path")
	}
	if r, _ := NewViewImage().Exec(context.Background(), map[string]any{"path": "."}, ExecContext{Cwd: dir}); !r.IsError {
		t.Error("expected error for a directory")
	}
}

func TestViewImageConfinedToCwd(t *testing.T) {
	dir := t.TempDir()
	// An absolute path outside the working directory must be rejected.
	outside := filepath.Join(t.TempDir(), "evil.png")
	os.WriteFile(outside, onePixelPNG, 0o644)
	res, _ := NewViewImage().Exec(context.Background(),
		map[string]any{"path": outside}, ExecContext{Cwd: dir})
	if !res.IsError {
		t.Fatal("expected path-confinement error for a file outside cwd")
	}
}

func TestViewImageReadOnlyConcurrencySafe(t *testing.T) {
	vi := NewViewImage()
	if !vi.IsReadOnly(nil) || !vi.IsConcurrencySafe(nil) {
		t.Fatal("view_image should be read-only and concurrency-safe")
	}
}
