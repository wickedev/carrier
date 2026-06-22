package store

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wickedev/carrier/internal/agent"
)

// FileStore is a stdlib-only Store rooted at a directory.
//
// Layout under the root, one subdirectory per session:
//
//	<root>/sessions/<sid>/log.jsonl    append-only records, one JSON object/line
//	<root>/sessions/<sid>/repl.json    replacements keyed by tool-call ID
//	<root>/index.json                  the SessionMeta index
//
// Concurrent appends to one session are serialized by a per-session mutex, so
// Seq stays monotonic and the log stays lossless. The index is guarded by its
// own mutex.
type FileStore struct {
	root string

	mu    sync.Mutex                 // guards sessions and index maps
	locks map[SessionID]*sessionLock // per-session lock + cached next Seq
	index map[SessionID]SessionMeta  // in-memory mirror of index.json
}

// sessionLock serializes appends for one session and caches its next Seq so
// monotonic assignment does not require re-reading the log on every append.
type sessionLock struct {
	mu      sync.Mutex
	nextSeq int // 0 means "unknown, recover from disk"
	loaded  bool
}

// compile-time interface checks.
var (
	_ Store = (*FileStore)(nil)
	_ Index = (*FileStore)(nil)
)

// NewFileStore opens (creating if needed) a FileStore rooted at dir.
func NewFileStore(dir string) (*FileStore, error) {
	if err := os.MkdirAll(filepath.Join(dir, "sessions"), 0o755); err != nil {
		return nil, fmt.Errorf("store: create root: %w", err)
	}
	fs := &FileStore{
		root:  dir,
		locks: make(map[SessionID]*sessionLock),
		index: make(map[SessionID]SessionMeta),
	}
	if err := fs.loadIndex(); err != nil {
		return nil, err
	}
	return fs, nil
}

func (fs *FileStore) sessionDir(sid SessionID) string {
	return filepath.Join(fs.root, "sessions", string(sid))
}

func (fs *FileStore) logPath(sid SessionID) string {
	return filepath.Join(fs.sessionDir(sid), "log.jsonl")
}

func (fs *FileStore) replPath(sid SessionID) string {
	return filepath.Join(fs.sessionDir(sid), "repl.json")
}

func (fs *FileStore) indexPath() string {
	return filepath.Join(fs.root, "index.json")
}

// lockFor returns the per-session lock, creating it on first use.
func (fs *FileStore) lockFor(sid SessionID) *sessionLock {
	fs.mu.Lock()
	defer fs.mu.Unlock()
	l, ok := fs.locks[sid]
	if !ok {
		l = &sessionLock{}
		fs.locks[sid] = l
	}
	return l
}

// Append implements Store.
func (fs *FileStore) Append(ctx context.Context, sid SessionID, rec Record) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if sid == "" {
		return fmt.Errorf("store: empty session id")
	}

	lock := fs.lockFor(sid)
	lock.mu.Lock()
	defer lock.mu.Unlock()

	if err := os.MkdirAll(fs.sessionDir(sid), 0o755); err != nil {
		return fmt.Errorf("store: create session dir: %w", err)
	}

	// Recover the next Seq from disk on first append in this process.
	if !lock.loaded {
		last, err := fs.lastSeqOnDisk(sid)
		if err != nil {
			return err
		}
		lock.nextSeq = last + 1
		lock.loaded = true
	}

	rec.Seq = lock.nextSeq
	rec.SessionID = sid
	if rec.Kind == "" {
		rec.Kind = KindTurn
	}
	if rec.CreatedAt.IsZero() {
		rec.CreatedAt = time.Now()
	}

	line, err := json.Marshal(rec)
	if err != nil {
		return fmt.Errorf("store: marshal record: %w", err)
	}

	f, err := os.OpenFile(fs.logPath(sid), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("store: open log: %w", err)
	}
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("store: write record: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return fmt.Errorf("store: sync log: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("store: close log: %w", err)
	}

	lock.nextSeq++

	if err := fs.touchIndex(sid, rec.Seq, rec.CreatedAt); err != nil {
		return err
	}
	return nil
}

// readLog returns every record in the session's log, in append order.
func (fs *FileStore) readLog(sid SessionID) ([]Record, error) {
	f, err := os.Open(fs.logPath(sid))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("store: open log: %w", err)
	}
	defer f.Close()

	var recs []Record
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for sc.Scan() {
		b := sc.Bytes()
		if len(b) == 0 {
			continue
		}
		var rec Record
		if err := json.Unmarshal(b, &rec); err != nil {
			return nil, fmt.Errorf("store: decode record: %w", err)
		}
		recs = append(recs, rec)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("store: scan log: %w", err)
	}
	return recs, nil
}

// lastSeqOnDisk returns the highest Seq present in the log, or 0 if none.
func (fs *FileStore) lastSeqOnDisk(sid SessionID) (int, error) {
	recs, err := fs.readLog(sid)
	if err != nil {
		return 0, err
	}
	last := 0
	for _, r := range recs {
		if r.Seq > last {
			last = r.Seq
		}
	}
	return last, nil
}

// History implements Store.
func (fs *FileStore) History(ctx context.Context, sid SessionID) ([]Record, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	recs, err := fs.readLog(sid)
	if err != nil {
		return nil, err
	}
	return replayToCheckpoint(recs), nil
}

// Messages implements Store.
func (fs *FileStore) Messages(ctx context.Context, sid SessionID) ([]agent.Message, error) {
	recs, err := fs.History(ctx, sid)
	if err != nil {
		return nil, err
	}
	return projectMessages(recs), nil
}

// PutReplacement implements Store.
func (fs *FileStore) PutReplacement(ctx context.Context, sid SessionID, r Replacement) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if sid == "" {
		return fmt.Errorf("store: empty session id")
	}

	lock := fs.lockFor(sid)
	lock.mu.Lock()
	defer lock.mu.Unlock()

	if err := os.MkdirAll(fs.sessionDir(sid), 0o755); err != nil {
		return fmt.Errorf("store: create session dir: %w", err)
	}

	repls, err := fs.readReplacements(sid)
	if err != nil {
		return err
	}
	repls[r.ToolCallID] = r
	return fs.writeReplacements(sid, repls)
}

// GetReplacement implements Store.
func (fs *FileStore) GetReplacement(ctx context.Context, sid SessionID, toolCallID string) (Replacement, bool, error) {
	if err := ctx.Err(); err != nil {
		return Replacement{}, false, err
	}
	lock := fs.lockFor(sid)
	lock.mu.Lock()
	defer lock.mu.Unlock()

	repls, err := fs.readReplacements(sid)
	if err != nil {
		return Replacement{}, false, err
	}
	r, ok := repls[toolCallID]
	return r, ok, nil
}

func (fs *FileStore) readReplacements(sid SessionID) (map[string]Replacement, error) {
	b, err := os.ReadFile(fs.replPath(sid))
	if err != nil {
		if os.IsNotExist(err) {
			return make(map[string]Replacement), nil
		}
		return nil, fmt.Errorf("store: read replacements: %w", err)
	}
	if len(b) == 0 {
		return make(map[string]Replacement), nil
	}
	m := make(map[string]Replacement)
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, fmt.Errorf("store: decode replacements: %w", err)
	}
	return m, nil
}

func (fs *FileStore) writeReplacements(sid SessionID, m map[string]Replacement) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return fmt.Errorf("store: encode replacements: %w", err)
	}
	return atomicWrite(fs.replPath(sid), b)
}

// --- Index ---

// Index implements Store.
func (fs *FileStore) Index() Index { return fs }

// List implements Index.
func (fs *FileStore) List(ctx context.Context) ([]SessionMeta, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()

	out := make([]SessionMeta, 0, len(fs.index))
	for _, m := range fs.index {
		out = append(out, m)
	}
	return out, nil
}

// Get implements Index.
func (fs *FileStore) Get(ctx context.Context, sid SessionID) (SessionMeta, bool, error) {
	if err := ctx.Err(); err != nil {
		return SessionMeta{}, false, err
	}
	fs.mu.Lock()
	defer fs.mu.Unlock()

	m, ok := fs.index[sid]
	return m, ok, nil
}

func (fs *FileStore) loadIndex() error {
	b, err := os.ReadFile(fs.indexPath())
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("store: read index: %w", err)
	}
	if len(b) == 0 {
		return nil
	}
	var metas []SessionMeta
	if err := json.Unmarshal(b, &metas); err != nil {
		return fmt.Errorf("store: decode index: %w", err)
	}
	for _, m := range metas {
		fs.index[m.SessionID] = m
	}
	return nil
}

// touchIndex updates the index entry for a session after an append.
func (fs *FileStore) touchIndex(sid SessionID, seq int, ts time.Time) error {
	fs.mu.Lock()
	defer fs.mu.Unlock()

	m, ok := fs.index[sid]
	if !ok {
		m = SessionMeta{
			SessionID: sid,
			Status:    StatusActive,
			CreatedAt: ts,
		}
	}
	if seq > m.LastSeq {
		m.LastSeq = seq
	}
	fs.index[sid] = m
	return fs.flushIndexLocked()
}

// flushIndexLocked persists the index. Caller must hold fs.mu.
func (fs *FileStore) flushIndexLocked() error {
	metas := make([]SessionMeta, 0, len(fs.index))
	for _, m := range fs.index {
		metas = append(metas, m)
	}
	b, err := json.MarshalIndent(metas, "", "  ")
	if err != nil {
		return fmt.Errorf("store: encode index: %w", err)
	}
	return atomicWrite(fs.indexPath(), b)
}

// atomicWrite writes data to path via a temp file + rename, so a reader never
// observes a partial file.
func atomicWrite(path string, data []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("store: temp file: %w", err)
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("store: write temp: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return fmt.Errorf("store: sync temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("store: close temp: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName)
		return fmt.Errorf("store: rename: %w", err)
	}
	return nil
}
