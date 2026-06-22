import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Usage } from "@carrier/contract";
import { UsagePill, formatUsd, formatTokens } from "./UsagePanel";

describe("usage formatting", () => {
  it("formats small costs with 4 digits and larger ones with 2", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("abbreviates token counts", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });
});

describe("UsagePill", () => {
  const usage: Usage = {
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 10,
    cacheWriteTokens: 20,
    costUsd: 0.0345,
  };

  it("renders total tokens + cost", () => {
    render(<UsagePill usage={usage} />);
    expect(screen.getByTestId("usage-pill")).toHaveTextContent("1.5k tok");
    expect(screen.getByTestId("usage-pill")).toHaveTextContent("$0.0345");
  });

  it("shows a loading placeholder while loading", () => {
    render(<UsagePill loading />);
    expect(screen.getByTestId("usage-pill")).toHaveTextContent("usage…");
  });

  it("renders nothing when there is no usage and not loading", () => {
    const { container } = render(<UsagePill />);
    expect(container).toBeEmptyDOMElement();
  });
});
