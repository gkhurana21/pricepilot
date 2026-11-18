import type { CSSProperties } from "react";
import type { ReviewRow } from "../services/types";
import { Badge } from "./Badge";
import {
  formatCents,
  formatElasticity,
  formatInterval,
  formatBp,
  formatShare,
  formatSignedBp,
  formatUnits,
  isApplicable,
  outcomeTone,
  plural,
  reasonMarker,
  ruleLabel,
} from "./format";
import { mono, plainList, srOnly, wrap } from "./styles";

// Each product is a stacked block, not a table row. A seven-column table with
// the reasons inside the first cell pushed the price and rule columns off the
// side of the Shopify admin. Stacked, nothing can overflow at any width, and
// the block reads top to bottom the way a merchant asks the questions: what
// product, what happens to its price, which rule decided, and why.

const rowList: CSSProperties = { listStyle: "none", margin: 0, padding: 0 };

const rowItem: CSSProperties = {
  padding: "14px 0",
  borderTop: "1px solid var(--p-color-border-secondary, #e3e3e3)",
};

const firstRowItem: CSSProperties = { ...rowItem, borderTop: "none", paddingTop: 4 };

const headLine: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: "4px 12px",
};

const priceLine: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "baseline",
  gap: "2px 16px",
  marginTop: 6,
  fontVariantNumeric: "tabular-nums",
};

const bigPrice: CSSProperties = { fontSize: "1.125rem", fontWeight: 600 };

const subdued: CSSProperties = { color: "var(--p-color-text-secondary, #616161)" };

function EstimateLine({ row }: { row: ReviewRow }) {
  const e = row.estimate;
  const interval = formatInterval(e.ci_low, e.ci_high);
  const parts: string[] = [];
  parts.push(`Elasticity ${formatElasticity(e.elasticity)}${interval ? ` ${interval}` : ""}`);
  if (e.method === "pooled") parts.push(`pooled ${formatShare(e.shrinkage)}`);
  parts.push(`${formatUnits(e.mean_units_per_day)} units/day`);
  if (row.trueElasticity !== null) {
    parts.push(`true value (synthetic): ${formatElasticity(row.trueElasticity)}`);
  }
  return (
    <div
      style={{ ...wrap, ...subdued }}
      title={
        e.method === "pooled"
          ? "Pooled: pulled toward the average of similar products because this product's own data is thin"
          : undefined
      }
    >
      {parts.join(" · ")}
    </div>
  );
}

function Reasons({ row, open }: { row: ReviewRow; open: boolean }) {
  const reasons = row.decision?.reasons ?? [];
  return (
    <details open={open} style={{ marginTop: 8 }}>
      <summary style={{ cursor: "pointer", ...subdued }}>
        {reasons.length === 0 ? "No guardrail objected" : `Why: ${plural(reasons.length, "reason")}`}
      </summary>
      {reasons.length > 0 && (
        <ul style={{ ...plainList, marginTop: 6 }}>
          {reasons.map((r, i) => {
            const m = reasonMarker(r.effect);
            return (
              <li key={`${r.rule}-${i}`} style={{ ...wrap, display: "flex", gap: 8 }}>
                <span aria-hidden="true" title={m.label} style={{ flex: "0 0 1ch" }}>
                  {m.symbol}
                </span>
                <span style={wrap}>
                  <span style={srOnly}>{m.label}: </span>
                  {r.message}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div style={{ marginTop: 6 }}>
        <EstimateLine row={row} />
      </div>
    </details>
  );
}

function ProductName({ row }: { row: ReviewRow }) {
  return (
    <div style={wrap}>
      <strong>{row.title}</strong>
      {row.sku && (
        <>
          {" "}
          <small style={{ ...mono, ...subdued }}>{row.sku}</small>
        </>
      )}
    </div>
  );
}

function RuleBadge({ row }: { row: ReviewRow }) {
  if (!row.decidingRule) return <Badge tone="success">All guardrails passed</Badge>;
  return (
    <span title={`Rule id: ${row.decidingRule}`}>
      <Badge tone={outcomeTone(row.outcome)}>{ruleLabel(row.decidingRule)}</Badge>
    </span>
  );
}

/** Held back, adjusted and approved rows: the enforcer saw a proposal. */
export function DecisionTable({
  rows,
  label,
  openReasons,
}: {
  rows: ReviewRow[];
  label: string;
  openReasons: boolean;
}) {
  return (
    <ul style={rowList} data-section={label}>
      {rows.map((row, i) => {
        const d = row.decision;
        const changes = isApplicable(row);
        return (
          <li key={row.skuId} style={i === 0 ? firstRowItem : rowItem}>
            <div style={headLine}>
              <ProductName row={row} />
              <RuleBadge row={row} />
            </div>

            <div style={priceLine}>
              {changes && d ? (
                <>
                  <span style={bigPrice}>
                    <span style={srOnly}>Current price </span>
                    {formatCents(row.currentPrice)}
                    <span aria-hidden="true"> → </span>
                    <span style={srOnly}> changes to </span>
                    {formatCents(d.final_price)}
                  </span>
                  <span>{formatSignedBp(d.delta_bp)}</span>
                  <span style={subdued}>margin after {formatBp(d.margin_bp)}</span>
                </>
              ) : (
                <>
                  <span style={bigPrice}>
                    <span style={srOnly}>Current price </span>
                    {formatCents(row.currentPrice)}
                  </span>
                  <span>stays as it is</span>
                </>
              )}
              <span style={subdued}>model proposed {formatCents(d?.proposed_price)}</span>
            </div>

            <Reasons row={row} open={openReasons} />
          </li>
        );
      })}
    </ul>
  );
}

/** Rows the estimator declined: there was no proposal for the policy to judge. */
export function NoProposalTable({ rows }: { rows: ReviewRow[] }) {
  return (
    <ul style={rowList} data-section="no_proposal">
      {rows.map((row, i) => (
        <li key={row.skuId} style={i === 0 ? firstRowItem : rowItem}>
          <div style={headLine}>
            <ProductName row={row} />
            <span title={row.noProposalCode ? `Refusal code: ${row.noProposalCode}` : undefined}>
              <Badge tone="neutral">
                {row.noProposalCode ? ruleLabel(row.noProposalCode) : "No unit cost"}
              </Badge>
            </span>
          </div>
          <div style={priceLine}>
            <span style={bigPrice}>
              <span style={srOnly}>Current price </span>
              {formatCents(row.currentPrice)}
            </span>
            <span>no proposal</span>
            <span style={subdued}>{formatUnits(row.estimate.mean_units_per_day)} units/day</span>
          </div>
          <div style={{ ...wrap, marginTop: 6 }}>{row.noProposalReason}</div>
        </li>
      ))}
    </ul>
  );
}
