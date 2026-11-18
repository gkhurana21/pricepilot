import type { RunListItem } from "../services/types";
import { Badge } from "./Badge";
import { formatDateTime, shortHash, statusLabel, statusTone } from "./format";
import { mono } from "./styles";

export function HistoryScreen({
  runs,
  error,
  hrefFor,
}: {
  runs: RunListItem[];
  error: string | null;
  hrefFor: (runId: string) => string;
}) {
  return (
    <s-page heading="Run history">
      <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Could not load run history">
            {error}
          </s-banner>
        )}
        {!error && runs.length === 0 && (
          <s-section heading="No runs yet">
            <s-paragraph>
              Runs appear here once you create a repricing preview from the Review page.
            </s-paragraph>
            <s-link href="/app">Go to Review</s-link>
          </s-section>
        )}
        {runs.length > 0 && (
          <s-section padding="none">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Created</s-table-header>
                <s-table-header listSlot="labeled">Status</s-table-header>
                <s-table-header listSlot="labeled">Policy</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Proposals</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Approved</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Adjusted</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Held back</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Applied</s-table-header>
                <s-table-header listSlot="labeled">Rolled back</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {runs.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-link href={hrefFor(r.id)}>{formatDateTime(r.createdAt)}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <Badge tone={statusTone(r.status)}>{statusLabel(r.status)}</Badge>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={mono}>
                        {r.policyId} v{r.policyVersion} {shortHash(r.policyHash)}
                      </span>
                    </s-table-cell>
                    <s-table-cell>{r.proposals}</s-table-cell>
                    <s-table-cell>{r.approved}</s-table-cell>
                    <s-table-cell>{r.adjusted}</s-table-cell>
                    <s-table-cell>{r.heldBack}</s-table-cell>
                    <s-table-cell>{r.applied}</s-table-cell>
                    <s-table-cell>{r.rolledBackAt ? formatDateTime(r.rolledBackAt) : "—"}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-section>
        )}
      </s-stack>
    </s-page>
  );
}
