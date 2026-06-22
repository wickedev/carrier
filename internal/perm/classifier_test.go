package perm

import (
	"context"
	"testing"
)

// allowClassifier is a trivial Classifier for the interface test.
type allowClassifier struct{ eff Effect }

func (a allowClassifier) Classify(context.Context, string, string) (Effect, error) {
	return a.eff, nil
}

func TestClassifierInterface(t *testing.T) {
	var c Classifier = allowClassifier{eff: Allow}
	got, err := c.Classify(context.Background(), "Bash", "ls")
	if err != nil || got != Allow {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestDenialTrackerFallback(t *testing.T) {
	d := NewDenialTracker(3)
	if d.Record(true) || d.Record(true) {
		t.Fatal("should not fall back before threshold")
	}
	if !d.Record(true) {
		t.Fatal("should fall back at the 3rd consecutive denial")
	}
	// A non-denial resets the streak.
	if d.Record(false) {
		t.Fatal("non-denial should not signal fallback")
	}
	if d.Record(true) {
		t.Fatal("streak should have reset")
	}
}

func TestDenialTrackerDisabled(t *testing.T) {
	d := NewDenialTracker(0)
	for i := 0; i < 10; i++ {
		if d.Record(true) {
			t.Fatal("threshold 0 should never fall back")
		}
	}
}
