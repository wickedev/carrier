package hitl

import (
	"context"
	"testing"
	"time"

	"github.com/wickedev/carrier/internal/flight"
)

func TestApproveResolveAllow(t *testing.T) {
	reqs := make(chan Request, 1)
	a := New(func(r Request) { reqs <- r }, time.Second)

	resultCh := make(chan bool, 1)
	go func() {
		ok, _ := a.Approve(context.Background(), flight.ApprovalRequest{Tool: "bash", Resource: "rm x"})
		resultCh <- ok
	}()

	r := <-reqs
	if r.Tool != "bash" {
		t.Fatalf("unexpected request %+v", r)
	}
	if !a.Resolve(r.ID, true) {
		t.Fatal("Resolve should succeed for a pending request")
	}
	if ok := <-resultCh; !ok {
		t.Fatal("expected approval")
	}
}

func TestApproveResolveDeny(t *testing.T) {
	reqs := make(chan Request, 1)
	a := New(func(r Request) { reqs <- r }, time.Second)
	resultCh := make(chan bool, 1)
	go func() {
		ok, _ := a.Approve(context.Background(), flight.ApprovalRequest{Tool: "bash"})
		resultCh <- ok
	}()
	r := <-reqs
	a.Resolve(r.ID, false)
	if ok := <-resultCh; ok {
		t.Fatal("expected denial")
	}
}

func TestApproveTimeoutDenies(t *testing.T) {
	a := New(func(Request) {}, 50*time.Millisecond)
	ok, err := a.Approve(context.Background(), flight.ApprovalRequest{Tool: "bash"})
	if err != nil || ok {
		t.Fatalf("expected timeout deny, got ok=%v err=%v", ok, err)
	}
	if a.Pending() != 0 {
		t.Fatal("pending should be cleared after timeout")
	}
}

func TestApproveContextCancel(t *testing.T) {
	a := New(func(Request) {}, 0)
	ctx, cancel := context.WithCancel(context.Background())
	resultCh := make(chan error, 1)
	go func() {
		_, err := a.Approve(ctx, flight.ApprovalRequest{Tool: "bash"})
		resultCh <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	if err := <-resultCh; err == nil {
		t.Fatal("expected context cancellation error")
	}
}

func TestResolveUnknownID(t *testing.T) {
	a := New(func(Request) {}, time.Second)
	if a.Resolve("nope", true) {
		t.Fatal("resolving an unknown ID should return false")
	}
}
