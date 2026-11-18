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
