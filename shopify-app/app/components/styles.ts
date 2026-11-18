import type { CSSProperties } from "react";

// Visually hidden text that screen readers still announce.
export const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// Long reason text must wrap rather than push the page wider than 375 px.
export const wrap: CSSProperties = {
  overflowWrap: "anywhere",
  wordBreak: "break-word",
  minWidth: 0,
};

export const mono: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  overflowWrap: "anywhere",
};

export const plainList: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: 4,
};

export const dlGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 16,
  margin: 0,
};

// ---- stacked rows ------------------------------------------------------------
// Each product is a stacked block, not a table row: name and badge on one
// wrapping line, prices on the next, explanation below. Nothing can push the
// page wider than the Shopify admin at any width.

export const rowList: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

export const rowItem: CSSProperties = {
  padding: "14px 0",
  borderTop: "1px solid var(--p-color-border-secondary, #e3e3e3)",
};

export const firstRowItem: CSSProperties = { ...rowItem, borderTop: "none", paddingTop: 4 };

export const headLine: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "4px 12px",
};

export const priceLine: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "2px 16px",
  marginTop: 6,
  fontVariantNumeric: "tabular-nums",
};

export const bigPrice: CSSProperties = { fontSize: "1.125rem", fontWeight: 600 };

export const subdued: CSSProperties = { color: "var(--p-color-text-secondary, #616161)" };

// Tabular figures so digits line up down a column.
export const numeric: CSSProperties = { fontVariantNumeric: "tabular-nums" };
