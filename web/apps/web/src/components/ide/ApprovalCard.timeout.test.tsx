import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "../../session/stream";

const base: PendingApproval = {
  reqId: "req-1",
  tool: "bash",
  resource: "rm -rf /tmp/x",
  reason: "Deletes files",
  seq: 7,
  receivedAt: Date.now(),
};

describe("ApprovalCard timeout/expiry (Req 11.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows an expired state and fires onExpire once the timeout elapses", () => {
    const onExpire = vi.fn();
    const start = Date.now();
    render(
      <ApprovalCard
        approval={{ ...base, receivedAt: start }}
        onDecide={vi.fn()}
        onExpire={onExpire}
        timeoutMs={1000}
      />,
    );

    // Not expired yet.
    expect(screen.queryByTestId("approval-expired")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1001);
    });

    expect(screen.getByTestId("approval-expired")).toBeInTheDocument();
    expect(screen.getByText(/timed out and was auto-denied/i)).toBeInTheDocument();
    // Approve disabled after expiry; Deny becomes a Dismiss.
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith("req-1");
  });

  it("renders as already-expired when receivedAt is past the timeout", () => {
    const onExpire = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, receivedAt: Date.now() - 5000 }}
        onDecide={vi.fn()}
        onExpire={onExpire}
        timeoutMs={1000}
      />,
    );
    expect(screen.getByTestId("approval-expired")).toBeInTheDocument();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("still allows a manual decision before expiry", () => {
    const onDecide = vi.fn();
    render(
      <ApprovalCard
        approval={{ ...base, receivedAt: Date.now() }}
        onDecide={onDecide}
        timeoutMs={10_000}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith("req-1", true);
  });
});
