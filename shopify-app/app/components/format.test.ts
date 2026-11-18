import { describe, it, expect } from "vitest";
import {
  countApplicable,
  exclusionsText,
  formatBp,
  formatCents,
  formatCount,
  formatDateTime,
  formatElasticity,
  formatInterval,
  formatSignedBp,
  funnelLine,
  reportLine,
  reasonMarker,
  shortHash,
  verifiedLabel,
  writeStatusLabel,
  ruleLabel,
} from "./format";
import type { ReviewRow, Summary, WriteItem, WriteReport } from "../services/types";

describe("formatCents", () => {
  it("always shows two decimals and a symbol", () => {
    expect(formatCents(1899)).toBe("$18.99");
    expect(formatCents(1800)).toBe("$18.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(0)).toBe("$0.00");
  });
  it("groups thousands and uses a real minus", () => {
    expect(formatCents(123456789)).toBe("$1,234,567.89");
    expect(formatCents(-500)).toBe("−$5.00");
  });
  it("shows a dash for missing values", () => {
    expect(formatCents(null)).toBe("—");
  });
});

describe("basis points", () => {
  it("formats rates with one decimal", () => {
    expect(formatBp(5380)).toBe("53.8%");
    expect(formatBp(4200)).toBe("42.0%");
    expect(formatBp(6000)).toBe("60.0%");
  });
  it("uses a real minus sign for negatives", () => {
    expect(formatBp(-874)).toBe("−8.7%");
    expect(formatSignedBp(-874)).toBe("−8.7%");
  });
  it("signs increases and never prints a negative zero", () => {
    expect(formatSignedBp(832)).toBe("+8.3%");
    expect(formatSignedBp(0)).toBe("0.0%");
    expect(formatSignedBp(-2)).toBe("0.0%");
  });
});

describe("elasticity", () => {
  it("formats with a real minus", () => {
    expect(formatElasticity(-2.4)).toBe("−2.40");
    expect(formatElasticity(null)).toBe("—");
  });
  it("formats intervals", () => {
    expect(formatInterval(-2.91, -1.68)).toBe("[−2.91, −1.68]");
    expect(formatInterval(null, -1)).toBe("");
  });
});

describe("misc", () => {
  it("groups counts", () => {
    expect(formatCount(4812)).toBe("4,812");
  });
  it("formats dates in a fixed zone", () => {
    expect(formatDateTime("2026-08-16T14:02:33Z")).toBe("2026-08-16 14:02 UTC");
    expect(formatDateTime(null)).toBe("—");
  });
  it("shortens hashes", () => {
    expect(shortHash("sha256:027a232f6814cd0b99")).toBe("027a232f6814");
  });
  it("labels reason effects", () => {
    expect(reasonMarker("blocked").symbol).toBe("×");
    expect(reasonMarker("clamped").symbol).toBe("→");
    expect(reasonMarker("bound").symbol).toBe("·");
    expect(reasonMarker("info").symbol).toBe("·");
  });
});

function row(
  action: "approve" | "clamp" | "reject" | null,
  current: number,
  final: number,
): ReviewRow {
  return {
    decision:
      action === null
        ? null
        : ({ action, current_price: current, final_price: final } as ReviewRow["decision"]),
  } as ReviewRow;
}

describe("countApplicable", () => {
  it("counts approve/clamp rows that change the price", () => {
    const rows = [
      row("approve", 2200, 1899),
      row("clamp", 4800, 5199),
      row("clamp", 1800, 1800), // lands on the current price: nothing to write
      row("reject", 1800, 0),
      row(null, 1500, 0),
    ];
    expect(countApplicable(rows)).toBe(2);
  });
});

describe("funnelLine", () => {
  it("reads the summary and the rows", () => {
    const summary = { total: 9, approved: 2, clamped: 3, rejected: 4 } as Summary;
    const rows = [
      { outcome: "approved" },
      { outcome: "no_proposal" },
      { outcome: "no_proposal" },
    ] as ReviewRow[];
    expect(funnelLine(summary, rows)).toBe(
      "3 products · 9 proposals · 2 approved · 3 adjusted · 4 held back · 2 no proposal",
    );
  });
});

describe("write reports", () => {
  const report = { applied: 7, skipped: 1, failed: 0, verified: 7 } as WriteReport;
  it("summarises", () => {
    expect(reportLine(report)).toBe(
      "7 written, 1 skipped, 0 failed · 7 of 7 verified by re-reading prices from Shopify",
    );
  });
  it("explains each status", () => {
    const base = { error: null } as WriteItem;
    expect(writeStatusLabel({ ...base, status: "stale_price" })).toContain(
      "price changed since the preview",
    );
    expect(writeStatusLabel({ ...base, status: "edited_since_apply" })).toContain(
      "edited after this run applied it",
    );
    expect(writeStatusLabel({ ...base, status: "api_error", error: "Throttled" })).toBe(
      "Failed: Throttled",
    );
  });
  it("shows verified or mismatch, never colour alone", () => {
    expect(verifiedLabel({ status: "applied", livePriceAfter: 1899, verified: true } as WriteItem)).toBe(
      "$18.99 ✓ verified",
    );
    expect(verifiedLabel({ status: "applied", livePriceAfter: 1900, verified: false } as WriteItem)).toContain(
      "does not match",
    );
    expect(verifiedLabel({ status: "applied", livePriceAfter: null, verified: false } as WriteItem)).toContain(
      "Could not",
    );
    expect(
      verifiedLabel({ status: "stale_price", livePriceAfter: 1950, verified: false } as WriteItem),
    ).toBe("$19.50 live now (not written)");
  });
});

describe("exclusionsText", () => {
  it("says None when empty", () => {
    expect(
      exclusionsText({ exclusions: { sku_ids: null, tags: [], collections: null } } as never),
    ).toBe("None");
  });
});

describe("ruleLabel", () => {
  it("names known rules in plain language", () => {
    expect(ruleLabel("max_decrease")).toBe("Largest decrease per run");
    expect(ruleLabel("volume_too_low")).toBe("Too few sales");
  });
  it("falls back to the id for an unknown rule and is empty for none", () => {
    expect(ruleLabel("some_new_rule")).toBe("some_new_rule");
    expect(ruleLabel(null)).toBe("");
  });
});
