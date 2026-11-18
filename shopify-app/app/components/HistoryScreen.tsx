import type { RunListItem } from "../services/types";
import { Badge } from "./Badge";
import { formatDateTime, shortHash, statusLabel, statusTone } from "./format";
import { mono, numeric, srOnly, subdued } from "./styles";

// Sized to fit the admin from 768 px up (narrower, Polaris lists each run as a
// card). The rollback time sits under the status badge; the policy column
// shows the version and hash, with the policy id in the tooltip (a shop has
// one policy id); and there is no "Proposals" column, since it is the sum of
// the three outcome columns. With all of them the last column was cut off.
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
                <s-table-header listSlot="labeled" format="numeric">Accepted</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Adjusted</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Held back</s-table-header>
                <s-table-header listSlot="labeled" format="numeric">Applied</s-table-header>
                <s-table-header listSlot="labeled">Policy</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {runs.map((r) => (
                  <s-table-row key={r.id}>
                    <s-table-cell>
                      <s-link href={hrefFor(r.id)}>{formatDateTime(r.createdAt)}</s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <Badge tone={statusTone(r.status, r.interrupted)}>
                        {statusLabel(r.status, r.interrupted)}
                      </Badge>
                      {r.rolledBackAt && (
                        <>
                          <br />
                          <span style={subdued}>
                            <span style={srOnly}>Rolled back at </span>
                            {formatDateTime(r.rolledBackAt)}
                          </span>
                        </>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <span style={numeric}>{r.accepted}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={numeric}>{r.adjusted}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={numeric}>{r.heldBack}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={numeric}>{r.applied}</span>
                    </s-table-cell>
                    <s-table-cell>
                      <span style={mono} title={`${r.policyId} version ${r.policyVersion}, ${r.policyHash}`}>
                        v{r.policyVersion}{" "}
                        <span style={subdued}>{shortHash(r.policyHash)}</span>
                      </span>
                    </s-table-cell>
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
