import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("ApprovalCard focus (a11y)", () => {
  it("moves focus to the card container on mount", () => {
    render(
      <ApprovalCard
        approval={{ ...base, receivedAt: Date.now() }}
        onDecide={vi.fn()}
        onExpire={vi.fn()}
        timeoutMs={10_000}
      />,
    );
    expect(screen.getByTestId("approval-card")).toHaveFocus();
  });
});
