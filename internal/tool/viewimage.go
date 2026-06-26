package tool

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"os"
)

// maxImageBytes caps an attached image's decoded size. Images ride in the model
// context (and are re-sent every turn), so a generous-but-bounded cap keeps a
// single picture from ballooning the request.
const maxImageBytes = 5 << 20 // 5 MiB

// imageMediaTypes are the formats vision models accept. http.DetectContentType
// reports these for the corresponding magic bytes.
var imageMediaTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// viewImageTool reads a local image file and attaches it to the model's context
// as vision input. The file is confined to the session working directory
// (symlink-safe). Read-only and concurrency-safe.
type viewImageTool struct{ Base }

// NewViewImage returns the view_image tool.
func NewViewImage() *viewImageTool {
	return &viewImageTool{Base{
		ToolName: "view_image",
		ToolDescription: "Attach a local image file (PNG, JPEG, GIF, or WebP) to the conversation " +
			"so you can see it. Provide a path within the working directory.",
		ReadOnly:        true,
		ConcurrencySafe: true,
		ToolSchema: obj(props{
			"path": strProp("Path to the image file, within the working directory."),
		}, "path"),
	}}
}

func (viewImageTool) Exec(_ context.Context, input map[string]any, ec ExecContext) (Result, error) {
	abs, err := resolveInCwd(ec.Cwd, strArg(input, "path"))
	if err != nil {
		return errResult("%v", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return errResult("%v", err)
	}
	if info.IsDir() {
		return errResult("%q is a directory, not an image", strArg(input, "path"))
	}
	if info.Size() > maxImageBytes {
		return errResult("image is %d bytes; the limit is %d", info.Size(), maxImageBytes)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult("%v", err)
	}
	// Detect the type from the content (magic bytes), not the extension.
	mediaType := normalizeMediaType(http.DetectContentType(data))
	if !imageMediaTypes[mediaType] {
		return errResult("unsupported image type %q (supported: png, jpeg, gif, webp)", mediaType)
	}
	return Result{
		Content: fmt.Sprintf("Attached image %s (%s, %d bytes).", strArg(input, "path"), mediaType, len(data)),
		Images:  []Image{{MediaType: mediaType, Base64: base64.StdEncoding.EncodeToString(data)}},
	}, nil
}

// normalizeMediaType strips any "; charset=..." suffix http.DetectContentType
// may append, leaving the bare media type.
func normalizeMediaType(s string) string {
	for i := 0; i < len(s); i++ {
		if s[i] == ';' || s[i] == ' ' {
			return s[:i]
		}
	}
	return s
}
