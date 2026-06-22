import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionEvent } from "@carrier/contract";
import { EventList } from "./EventList";
import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "../../session/stream";

describe("EventList", () => {
  it("renders structured cards per event kind and omits approval requests", () => {
    const events: SessionEvent[] = [
      { seq: 1, kind: "text", text: "Hello there" },
      { seq: 2, kind: "tool_call", id: "t1", name: "bash", input: { cmd: "ls" } },
      { seq: 3, kind: "tool_result", id: "t1", content: "file.txt", isError: false },
      { seq: 4, kind: "file_changed", path: "src/a.ts", status: "M" },
      {
        seq: 5,
        kind: "approval_request",
        reqId: "r1",
        tool: "bash",
        resource: "x",
        reason: "y",
      },
    ];
    render(<EventList events={events} />);
    expect(screen.getByText("Hello there")).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("file.txt")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    // approval_request is surfaced separately, not in the event list
    expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
  });
});

describe("ApprovalCard", () => {
  const approval: PendingApproval = {
    reqId: "req-1",
    tool: "bash",
    resource: "rm -rf /tmp/x",
    reason: "Deletes files",
    seq: 7,
    receivedAt: Date.now(),
  };

  it("renders the request and correlates approve/deny to the reqId", () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval} onDecide={onDecide} />);
    expect(screen.getByText("rm -rf /tmp/x")).toBeInTheDocument();
    expect(screen.getByText("Deletes files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onDecide).toHaveBeenCalledWith("req-1", true);

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDecide).toHaveBeenCalledWith("req-1", false);
  });

  it("disables controls while a decision is pending", () => {
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} pending />);
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });
});
