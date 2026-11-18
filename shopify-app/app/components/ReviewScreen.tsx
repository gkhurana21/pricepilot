import { useState } from "react";
import type { Policy, RunView } from "../services/types";
import { Badge } from "./Badge";
import { PolicyPanel } from "./PolicyPanel";
import { DecisionTable, NoProposalTable } from "./RowTables";
import { WriteReportSection } from "./WriteReportSection";
import {
  countApplicable,
  formatCount,
  formatDateTime,
  funnelLine,
  plural,
  rowsByOutcome,
  shortHash,
  statusLabel,
  statusTone,
} from "./format";
import { mono, wrap } from "./styles";

export type Intent = "create" | "apply" | "rollback";

export interface ReviewScreenProps {
  run: RunView | null;
  policy: { policy: Policy; policyHash: string } | null;
  /** The action currently in flight, if any. */
  busy: Intent | null;
  error: string | null;
  /** Neutral message, used by the preview route to say buttons do nothing. */
  notice?: string | null;
  onCreate: () => void;
  onApply: () => void;
  onRollback: () => void;
}

export function ReviewScreen(props: ReviewScreenProps) {
  const { run, policy, busy, error, notice, onCreate, onApply, onRollback } = props;
  const [confirmRollback, setConfirmRollback] = useState(false);
  const anyBusy = busy !== null;

  const status = run?.status;
  const applicable = run ? countApplicable(run.rows) : 0;
  const canRollBack = status === "APPLIED" || status === "PARTIAL";
  const policyToShow = run ? { policy: run.policy, policyHash: run.policyHash } : policy;

  return (
    <s-page heading="Price review">
      {!run && (
        <s-button
          slot="primary-action"
          variant="primary"
          {...(busy === "create" ? { loading: true } : {})}
          {...(anyBusy ? { disabled: true } : {})}
          onClick={onCreate}
        >
          Run repricing preview
        </s-button>
      )}
      {status === "PREVIEW" && (
        <>
          <s-button
            slot="primary-action"
            variant="primary"
            {...(busy === "apply" ? { loading: true } : {})}
            {...(anyBusy || applicable === 0 ? { disabled: true } : {})}
            onClick={onApply}
          >
            {`Apply ${plural(applicable, "price change")}`}
          </s-button>
          <s-button
            slot="secondary-actions"
            {...(busy === "create" ? { loading: true } : {})}
            {...(anyBusy ? { disabled: true } : {})}
            onClick={onCreate}
          >
            Run again
          </s-button>
        </>
      )}
      {canRollBack && (
        <s-button
          slot="primary-action"
          tone="critical"
          {...(anyBusy || confirmRollback ? { disabled: true } : {})}
          onClick={() => setConfirmRollback(true)}
        >
          Roll back this run
        </s-button>
      )}
      {run && !!status && !["PREVIEW", "APPLIED", "PARTIAL"].includes(status) && (
        <s-button
          slot="primary-action"
          variant="primary"
          {...(busy === "create" ? { loading: true } : {})}
          {...(anyBusy ? { disabled: true } : {})}
          onClick={onCreate}
        >
          Run repricing preview
        </s-button>
      )}

      <s-stack direction="block" gap="base">
        {error && (
          <s-banner tone="critical" heading="Something went wrong">
            <span style={wrap}>{error}</span>
          </s-banner>
        )}
        {notice && <s-banner tone="info">{notice}</s-banner>}

        {!run && (
          <s-section heading="No repricing run yet">
            <s-paragraph>
              A run reads your products and order history, proposes price changes from an
              elasticity model, and lets a policy approve, adjust or refuse each one. Nothing
              is written to your store until you apply it.
            </s-paragraph>
            <s-button
              variant="primary"
              {...(busy === "create" ? { loading: true } : {})}
              {...(anyBusy ? { disabled: true } : {})}
              onClick={onCreate}
            >
              Run repricing preview
            </s-button>
          </s-section>
        )}

        {run && (
          <>
            <RunHeader run={run} />
            {run.dataBasis.synthetic && <SyntheticBanner run={run} />}
            <s-paragraph>{funnelLine(run.summary, run.rows)}</s-paragraph>

            {confirmRollback && canRollBack && (
              <s-banner tone="warning" heading="Roll back this run?">
                <s-paragraph>
                  This restores every price the run changed to its previous value. Variants
                  whose price was edited since will be skipped and left as they are.
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    tone="critical"
                    {...(busy === "rollback" ? { loading: true } : {})}
                    {...(anyBusy ? { disabled: true } : {})}
                    onClick={() => {
                      onRollback();
                      setConfirmRollback(false);
                    }}
                  >
                    Yes, roll back
                  </s-button>
                  <s-button {...(anyBusy ? { disabled: true } : {})} onClick={() => setConfirmRollback(false)}>
                    Cancel
                  </s-button>
                </s-stack>
              </s-banner>
            )}

            {status === "PREVIEW" && applicable === 0 && (
              <s-banner tone="info" heading="Nothing to apply">
                No proposal survived the policy with a price different from today&apos;s, so
                there are no changes to write. The reasons are below.
              </s-banner>
            )}
            {status === "PREVIEW" && (
              <s-paragraph>
                Nothing below has been applied. Applying writes the approved and adjusted
                prices to Shopify and stores a snapshot, so this run can be rolled back.
              </s-paragraph>
            )}

            {run.apply && <WriteReportSection heading="Apply report" report={run.apply} />}
            {run.rollback && (
              <WriteReportSection heading="Rollback report" report={run.rollback} />
            )}

            <OutcomeSections run={run} />
          </>
        )}

        {policyToShow && (
          <PolicyPanel policy={policyToShow.policy} policyHash={policyToShow.policyHash} />
        )}
      </s-stack>
    </s-page>
  );
}

function RunHeader({ run }: { run: RunView }) {
  return (
    <s-stack direction="inline" gap="base" alignItems="center">
      <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
      <s-text>Created {formatDateTime(run.createdAt)}</s-text>
      <s-text>
        Policy <span style={mono}>{run.policy.id}</span> v{run.policy.version}{" "}
        <code style={mono} title={run.policyHash}>
          {shortHash(run.policyHash)}
        </code>
      </s-text>
    </s-stack>
  );
}

function SyntheticBanner({ run }: { run: RunView }) {
  const b = run.dataBasis;
  const range = b.firstDay && b.lastDay ? ` between ${b.firstDay} and ${b.lastDay}` : "";
  return (
    <s-banner tone="warning" heading="Synthetic order history">
      <s-paragraph>
        These estimates come from {`${formatCount(b.orderCount)} synthetic ${b.orderCount === 1 ? "order" : "orders"}`}
        {range}. Estimates from synthetic data are not evidence about real demand.
      </s-paragraph>
    </s-banner>
  );
}

function OutcomeSections({ run }: { run: RunView }) {
  const held = rowsByOutcome(run.rows, "held_back");
  const adjusted = rowsByOutcome(run.rows, "adjusted");
  const approved = rowsByOutcome(run.rows, "approved");
  const none = rowsByOutcome(run.rows, "no_proposal");
  return (
    <>
      {held.length > 0 && (
        <s-section heading="Held back: proposed, and the policy refused">
          <s-paragraph>
            The model proposed these changes and a policy rule stopped each one. The price
            stays as it is.
          </s-paragraph>
          <DecisionTable rows={held} label="held_back" openReasons />
        </s-section>
      )}
      {adjusted.length > 0 && (
        <s-section heading="Adjusted: moved to the nearest compliant price">
          <DecisionTable rows={adjusted} label="adjusted" openReasons />
        </s-section>
      )}
      {approved.length > 0 && (
        <s-section heading="Approved: cleared every guardrail">
          <DecisionTable rows={approved} label="approved" openReasons={false} />
        </s-section>
      )}
      {none.length > 0 && (
        <s-section heading="No proposal: the estimator declined">
          <s-paragraph>
            The estimator refused to propose a price for these, so the policy never saw them.
          </s-paragraph>
          <NoProposalTable rows={none} />
        </s-section>
      )}
    </>
  );
}
