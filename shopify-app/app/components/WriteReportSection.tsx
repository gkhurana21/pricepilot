import type { WriteReport } from "../services/types";
import { Badge } from "./Badge";
import {
  formatCents,
  formatDateTime,
  reportLine,
  verifiedLabel,
  writeStatusLabel,
  writeStatusTone,
} from "./format";
import { wrap } from "./styles";

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
        <s-text color="subdued">{formatDateTime(report.at)}</s-text>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Product</s-table-header>
            <s-table-header listSlot="labeled">Price change</s-table-header>
            <s-table-header listSlot="labeled">Status</s-table-header>
            <s-table-header listSlot="labeled">Live price read back from Shopify</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {report.items.map((item) => (
              <s-table-row key={item.skuId}>
                <s-table-cell>
                  <span style={wrap}>{item.title}</span>
                </s-table-cell>
                <s-table-cell>
                  {formatCents(item.fromPrice)} {"→"} {formatCents(item.toPrice)}
                </s-table-cell>
                <s-table-cell>
                  <div style={wrap}>
                    <Badge tone={writeStatusTone(item)}>{writeStatusLabel(item)}</Badge>
                  </div>
                </s-table-cell>
                <s-table-cell>
                  <span style={wrap}>{verifiedLabel(item)}</span>
                </s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-stack>
    </s-section>
  );
}
