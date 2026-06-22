package agent

import (
	"fmt"
	"time"
)

// ErrorClass categorizes a provider/engine failure so the agent loop can decide
// how to react without inspecting provider-specific error types.
type ErrorClass int

const (
	ErrFatal           ErrorClass = iota // non-recoverable; terminate the Flight
	ErrRetryable                         // transient; safe to retry with backoff
	ErrRateLimited                       // throttled; honor RetryAfter
	ErrContextOverflow                   // context window exceeded; compact and retry
	ErrQuotaExceeded                     // hard quota/billing limit
	ErrRefusal                           // model declined for policy reasons
)

// EngineError is a typed, classified error surfaced by an Engine. Adapters
// translate provider-specific failures into one of these so the loop and retry
// logic stay provider-agnostic.
type EngineError struct {
	Class      ErrorClass
	Provider   string
	Message    string
	RetryAfter time.Duration // meaningful for ErrRateLimited / ErrRetryable
	Err        error         // wrapped underlying error, if any
}

func (e *EngineError) Error() string {
	if e == nil {
		return "<nil engine error>"
	}
	if e.Provider != "" {
		return fmt.Sprintf("engine(%s): %s: %s", e.Provider, e.Class, e.Message)
	}
	return fmt.Sprintf("engine: %s: %s", e.Class, e.Message)
}

func (e *EngineError) Unwrap() error { return e.Err }

// Retryable reports whether the error class is safe to retry (possibly after a
// loop transition such as compaction).
func (e *EngineError) Retryable() bool {
	switch e.Class {
	case ErrRetryable, ErrRateLimited, ErrContextOverflow:
		return true
	default:
		return false
	}
}

func (c ErrorClass) String() string {
	switch c {
	case ErrFatal:
		return "fatal"
	case ErrRetryable:
		return "retryable"
	case ErrRateLimited:
		return "rate_limited"
	case ErrContextOverflow:
		return "context_overflow"
	case ErrQuotaExceeded:
		return "quota_exceeded"
	case ErrRefusal:
		return "refusal"
	default:
		return "unknown"
	}
}
