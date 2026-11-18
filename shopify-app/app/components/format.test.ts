import { describe, it, expect } from "vitest";
import {
  acceptedBadgeText,
  batchBudgetText,
  hardBoundsText,
  countApplicable,
  exclusionsText,
  formatBp,
  formatCents,
  formatCount,
  formatDateTime,
  formatDay,
  formatElasticity,
  formatInterval,
  formatSignedBp,
  funnelLine,
  reportLine,
  priceEnding,
  reasonMarker,
  shortHash,
  statusLabel,
  statusTone,
  verifiedLabel,
  writeStatusBadge,
  writeStatusDetail,
  ruleLabel,
} from "./format";
import type { Policy, ReviewRow, WriteItem, WriteReport } from "../services/types";
import { fixturePolicy } from "../fixtures/runs";

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
  it("formats dates in a fixed zone, and says so", () => {
    expect(formatDateTime("2026-08-16T14:02:33Z")).toBe("2026-08-16 14:02 UTC");
    expect(formatDateTime(null)).toBe("—");
    expect(formatDay("2026-02-17")).toBe("2026-02-17 UTC");
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
  it("counts the groups the screen shows", () => {
    const rows = [
      { outcome: "accepted" },
      { outcome: "accepted" },
      { outcome: "adjusted" },
      { outcome: "held_back" },
      { outcome: "no_proposal" },
      { outcome: "no_proposal" },
    ] as ReviewRow[];
    expect(funnelLine(rows)).toBe(
      "6 products · 4 proposals · 2 accepted · 1 adjusted by a guardrail · 1 held back · 2 no proposal",
    );
  });
});

describe("run status", () => {
  it("shows a write as in progress until the server calls it interrupted", () => {
    expect(statusLabel("APPLYING")).toBe("Applying");
    expect(statusTone("APPLYING")).toBe("info");
    expect(statusLabel("ROLLING_BACK")).toBe("Rolling back");
    expect(statusLabel("APPLYING", true)).toBe("Interrupted");
    expect(statusLabel("ROLLING_BACK", true)).toBe("Interrupted");
    expect(statusTone("APPLYING", true)).toBe("critical");
    expect(statusLabel("ROLLBACK_PARTIAL")).toBe("Partly rolled back");
  });
});

describe("accepted rows", () => {
  const rounded = { decidingRule: "rounding" } as ReviewRow;
  const untouched = { decidingRule: null } as ReviewRow;
  it("names the policy's price ending, from the policy's own integers", () => {
    expect(priceEnding(fixturePolicy)).toBe(".99");
    expect(acceptedBadgeText(rounded, fixturePolicy)).toBe("Rounded to .99");
    expect(acceptedBadgeText(untouched, fixturePolicy)).toBe("All guardrails passed");
  });
  it("falls back to plain words for an ending it cannot write as .NN", () => {
    const fives: Policy = { ...fixturePolicy, rounding: { modulus: 500, residue: 499, enabled: true } };
    expect(priceEnding(fives)).toBeNull();
    expect(acceptedBadgeText(rounded, fives)).toBe("Rounded to the price ending");
    const off: Policy = { ...fixturePolicy, rounding: { modulus: 100, residue: 99, enabled: false } };
    expect(priceEnding(off)).toBeNull();
  });
});

describe("write reports", () => {
  const report = { applied: 7, skipped: 1, failed: 0, verified: 7, items: [] } as unknown as WriteReport;
  it("summarises", () => {
    expect(reportLine(report)).toBe(
      "7 written, 1 skipped, 0 failed · 7 of 7 verified by re-reading prices from Shopify",
    );
  });
  it("names items an interrupted write never wrote", () => {
    const items = [{ status: "not_written" }, { status: "not_written" }, { status: "api_error" }] as WriteItem[];
    expect(reportLine({ applied: 2, skipped: 1, failed: 3, verified: 2, items } as WriteReport)).toBe(
      "2 written, 1 skipped, 1 failed, 2 not written · 2 of 2 verified by re-reading prices from Shopify",
    );
  });
  it("gives each status a short badge and a plain explanation", () => {
    const base = { error: null } as WriteItem;
    expect(writeStatusBadge({ ...base, status: "applied" })).toBe("Applied");
    expect(writeStatusDetail({ ...base, status: "applied" })).toBeNull();
    expect(writeStatusBadge({ ...base, status: "stale_price" })).toBe("Skipped");
    expect(writeStatusDetail({ ...base, status: "stale_price" })).toContain("changed after the preview");
    expect(writeStatusBadge({ ...base, status: "edited_since_apply" })).toBe("Skipped");
    expect(writeStatusDetail({ ...base, status: "edited_since_apply" })).toContain("edited outside this app");
    expect(writeStatusBadge({ ...base, status: "api_error", error: "Throttled" })).toBe("Failed");
    expect(writeStatusDetail({ ...base, status: "api_error", error: "Throttled" })).toBe(
      "Shopify returned an error: Throttled",
    );
    expect(writeStatusBadge({ ...base, status: "not_written" })).toBe("Not written");
    expect(writeStatusDetail({ ...base, status: "not_written" })).toContain("stopped before");
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
    expect(
      verifiedLabel({ status: "not_written", livePriceAfter: 2300, verified: false } as WriteItem),
    ).toBe("$23.00 live now (not written)");
  });
});

describe("policy text", () => {
  it("treats a zero hard bound and a full batch budget as inactive, like the engine", () => {
    const p = (over: Partial<Policy>) => ({ ...fixturePolicy, ...over });
    expect(hardBoundsText(p({ hard_floor: 0, hard_ceiling: 0 }))).toBe("None");
    expect(hardBoundsText(p({ hard_floor: 100, hard_ceiling: 0 }))).toBe("At least $1.00");
    expect(hardBoundsText(p({ hard_floor: 0, hard_ceiling: 5000 }))).toBe("At most $50.00");
    expect(hardBoundsText(p({ hard_floor: 100, hard_ceiling: 5000 }))).toBe("$1.00 to $50.00");
    expect(batchBudgetText(p({ max_skus_changed_bp: 10000 }))).toBe("No limit");
    expect(batchBudgetText(p({ max_skus_changed_bp: 0 }))).toBe("No limit");
    expect(batchBudgetText(p({ max_skus_changed_bp: 2500 }))).toBe("At most 25.0% of the products proposed");
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

describe("rollback wording", () => {
  const item = { skuId: "a", title: "A", fromPrice: 1699, toPrice: 1900, status: "applied", error: null, livePriceAfter: 1900, verified: true } as never;
  it("calls a written item Restored in a rollback report and Applied in an apply report", () => {
    expect(writeStatusBadge(item, "rollback")).toBe("Restored");
    expect(writeStatusBadge(item, "apply")).toBe("Applied");
    expect(writeStatusBadge(item)).toBe("Applied");
  });
  it("says restored in the rollback summary line", () => {
    const report = { at: "", attempted: 1, applied: 1, skipped: 0, failed: 0, verified: 1, items: [item] } as never;
    expect(reportLine(report, "rollback")).toContain("1 restored");
    expect(reportLine(report)).toContain("1 written");
  });
});
