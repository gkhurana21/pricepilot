import type { WriteReport } from "../services/types";
import { Badge } from "./Badge";
import {
  formatCents,
  formatDateTime,
  reportLine,
  verifiedLabel,
  writeStatusBadge,
  writeStatusDetail,
  writeStatusTone,
} from "./format";
import {
  bigPrice,
  firstRowItem,
  headLine,
  priceLine,
  rowItem,
  rowList,
  srOnly,
  subdued,
  wrap,
} from "./styles";

// Stacked like the decision rows (RowTables.tsx): a four-column table with a
// Shopify error message in one cell pushed the last column out of view.
export function WriteReportSection({
  heading,
  report,
}: {
  heading: string;
  report: WriteReport;
}) {
  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{reportLine(report)}</s-paragraph>
        <s-text color="subdued">
          {report.recovered
            ? `Rebuilt ${formatDateTime(report.at)} from the live prices in Shopify, after the write was interrupted.`
            : formatDateTime(report.at)}
        </s-text>
        <ul style={rowList}>
          {report.items.map((item, i) => {
            const detail = writeStatusDetail(item);
            return (
              <li key={item.skuId} style={i === 0 ? firstRowItem : rowItem}>
                <div style={headLine}>
                  <strong style={wrap}>{item.title}</strong>
                  <Badge tone={writeStatusTone(item)}>{writeStatusBadge(item)}</Badge>
                </div>
                <div style={priceLine}>
                  <span style={bigPrice}>
                    <span style={srOnly}>From </span>
                    {formatCents(item.fromPrice)}
                    <span aria-hidden="true"> → </span>
                    <span style={srOnly}> to </span>
                    {formatCents(item.toPrice)}
                  </span>
                  <span style={subdued}>{verifiedLabel(item)}</span>
                </div>
                {detail && <div style={{ ...wrap, marginTop: 6 }}>{detail}</div>}
              </li>
            );
          })}
        </ul>
      </s-stack>
    </s-section>
  );
}
