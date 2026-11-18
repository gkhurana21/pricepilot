import { useState } from "react";
import type { Policy, RunView } from "../services/types";
import { Badge } from "./Badge";
import { DATA_SECTION_ID, DataSection } from "./DataSection";
import { PolicyPanel } from "./PolicyPanel";
import { DecisionTable, NoProposalTable } from "./RowTables";
import { WriteReportSection } from "./WriteReportSection";
import {
  countApplicable,
  formatCount,
  formatDateTime,
  formatDay,
  funnelLine,
  plural,
  priceEnding,
  rowsByOutcome,
  shortHash,
  statusLabel,
  statusTone,
} from "./format";
import { mono, wrap } from "./styles";

export type Intent = "create" | "apply" | "rollback" | "recover";

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
  onRecover: () => void;
}

const loading = (on: boolean) => (on ? { loading: true } : {});
const disabled = (on: boolean) => (on ? { disabled: true } : {});

export function ReviewScreen(props: ReviewScreenProps) {
  const { run, policy, busy, error, notice, onCreate, onApply, onRollback, onRecover } = props;
  const [confirmRollback, setConfirmRollback] = useState(false);
  const anyBusy = busy !== null;

  const status = run?.status;
  const writing = status === "APPLYING" || status === "ROLLING_BACK";
  // While a write is in flight or interrupted, nothing else is offered: the
  // run's prices on Shopify are not known until it finishes or is reconciled.
  const interrupted = writing && !!run?.interrupted;
  const inFlight = writing && !interrupted;
  const applicable = run ? countApplicable(run.rows) : 0;
  const canRollBack = status === "APPLIED" || status === "PARTIAL" || status === "ROLLBACK_PARTIAL";
  const retryRollback = status === "ROLLBACK_PARTIAL";
  const canCreate = !run || status === "FAILED" || status === "ROLLED_BACK" || status === "ROLLBACK_PARTIAL";
  const policyToShow = run ? { policy: run.policy, policyHash: run.policyHash } : policy;

  return (
    <s-page heading="Price review">
      {status === "PREVIEW" && (
        <>
          <s-button
            slot="primary-action"
            variant="primary"
            {...loading(busy === "apply")}
            {...disabled(anyBusy || applicable === 0)}
            onClick={onApply}
          >
            {`Apply ${plural(applicable, "price change")}`}
          </s-button>
          <s-button
            slot="secondary-actions"
            {...loading(busy === "create")}
            {...disabled(anyBusy)}
            onClick={onCreate}
          >
            Run again
          </s-button>
        </>
      )}
      {canRollBack && (
        // The page's primary-action slot renders only a primary-variant button;
        // a critical tone alone left this action invisible.
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          {...disabled(anyBusy || confirmRollback)}
          onClick={() => setConfirmRollback(true)}
        >
          {retryRollback ? "Roll back the rest" : "Roll back this run"}
        </s-button>
      )}
      {canCreate && (
        <s-button
          slot={retryRollback ? "secondary-actions" : "primary-action"}
          {...(retryRollback ? {} : { variant: "primary" as const })}
          {...loading(busy === "create")}
          {...disabled(anyBusy)}
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

        {run && interrupted && <InterruptedBanner run={run} busy={busy} onRecover={onRecover} />}
        {run && inFlight && <InFlightBanner run={run} />}

        {!run && (
          <s-section heading="No repricing run yet">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                A run reads your products and order history, proposes price changes from an
                elasticity model, and lets a policy approve, adjust or refuse each one.
                Nothing is written to your store until you apply it.
              </s-paragraph>
              <s-paragraph>
                See <s-link href={`#${DATA_SECTION_ID}`}>Data this app reads</s-link> for
                exactly what a run reads and keeps.
              </s-paragraph>
              <s-stack direction="inline">
                <s-button
                  variant="primary"
                  {...loading(busy === "create")}
                  {...disabled(anyBusy)}
                  onClick={onCreate}
                >
                  Run repricing preview
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>
        )}

        {run && (
          <>
            <RunHeader run={run} />
            {run.dataBasis.synthetic && <SyntheticBanner run={run} />}
            <s-paragraph>{funnelLine(run.rows)}</s-paragraph>

            {confirmRollback && canRollBack && (
              <s-banner tone="warning" heading={retryRollback ? "Roll back the rest?" : "Roll back this run?"}>
                <s-stack direction="block" gap="base">
                  <s-paragraph>
                    {retryRollback
                      ? "This tries again for every price the last rollback did not restore. Prices already restored are left as they are, and variants whose price was edited since are skipped."
                      : "This restores every price the run changed to its previous value. Variants whose price was edited since will be skipped and left as they are."}
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-button
                      tone="critical"
                      {...loading(busy === "rollback")}
                      {...disabled(anyBusy)}
                      onClick={() => {
                        onRollback();
                        setConfirmRollback(false);
                      }}
                    >
                      Yes, roll back
                    </s-button>
                    <s-button {...disabled(anyBusy)} onClick={() => setConfirmRollback(false)}>
                      Cancel
                    </s-button>
                  </s-stack>
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
                Nothing below has been applied. Applying writes the accepted and adjusted
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

        <DataSection />
      </s-stack>
    </s-page>
  );
}

function InterruptedBanner({
  run,
  busy,
  onRecover,
}: {
  run: RunView;
  busy: Intent | null;
  onRecover: () => void;
}) {
  const what = run.status === "ROLLING_BACK" ? "Rolling back" : "Applying";
  return (
    <s-banner tone="critical" heading="A write to Shopify was interrupted">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          {what} this run started at <When iso={run.writeStartedAt} /> and stopped before it
          finished. Prices on Shopify may be partly changed.
        </s-paragraph>
        <s-paragraph>
          Checking reads the live price of every product the write planned to change and
          records exactly what landed. It writes no prices. Nothing else can be done on
          this run until it is checked.
        </s-paragraph>
        <s-stack direction="inline">
          <s-button
            variant="primary"
            {...loading(busy === "recover")}
            {...disabled(busy !== null)}
            onClick={onRecover}
          >
            Check what was written
          </s-button>
        </s-stack>
      </s-stack>
    </s-banner>
  );
}

function InFlightBanner({ run }: { run: RunView }) {
  const what = run.status === "ROLLING_BACK" ? "rolled back" : "applied";
  return (
    <s-banner tone="info" heading={`This run is being ${what}`}>
      <s-paragraph>
        Writing prices to Shopify started at <When iso={run.writeStartedAt} />. Reload this page
        in a moment to see the result.
      </s-paragraph>
    </s-banner>
  );
}

/** A timestamp that never breaks across lines ("2026-" / "08-16"). */
function When({ iso }: { iso: string | null }) {
  return (
    <time dateTime={iso ?? undefined} style={{ whiteSpace: "nowrap" }}>
      {formatDateTime(iso)}
    </time>
  );
}

function RunHeader({ run }: { run: RunView }) {
  return (
    <s-stack direction="inline" gap="small-200 base" alignItems="center">
      <Badge tone={statusTone(run.status, run.interrupted)}>
        {statusLabel(run.status, run.interrupted)}
      </Badge>
      <s-text>
        Created <When iso={run.createdAt} />
      </s-text>
      <span style={wrap}>
        <s-text>
          Policy <span style={mono}>{run.policy.id}</span> v{run.policy.version}{" "}
          <code style={mono} title={run.policyHash}>
            {shortHash(run.policyHash)}
          </code>
        </s-text>
      </span>
    </s-stack>
  );
}

function SyntheticBanner({ run }: { run: RunView }) {
  const b = run.dataBasis;
  const range =
    b.firstDay && b.lastDay ? ` processed between ${formatDay(b.firstDay)} and ${formatDay(b.lastDay)}` : "";
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
  const accepted = rowsByOutcome(run.rows, "accepted");
  const none = rowsByOutcome(run.rows, "no_proposal");
  const ending = priceEnding(run.policy);
  return (
    <>
      {held.length > 0 && (
        <s-section heading="Held back: proposed, and the policy refused">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The model proposed these changes and a policy rule stopped each one. The price
              stays as it is.
            </s-paragraph>
            <DecisionTable rows={held} label="held_back" openReasons policy={run.policy} />
          </s-stack>
        </s-section>
      )}
      {adjusted.length > 0 && (
        <s-section heading="Adjusted by a guardrail">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              A policy rule disagreed with the model, so the price moves only as far as the
              rule allows.
            </s-paragraph>
            <DecisionTable rows={adjusted} label="adjusted" openReasons policy={run.policy} />
          </s-stack>
        </s-section>
      )}
      {accepted.length > 0 && (
        <s-section heading="Accepted">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              {ending
                ? `Every guardrail passed. Where the model's price did not end in ${ending}, the engine moved it to a price that does, inside the range the rules allow.`
                : "Every guardrail passed."}
            </s-paragraph>
            <DecisionTable rows={accepted} label="accepted" openReasons={false} policy={run.policy} />
          </s-stack>
        </s-section>
      )}
      {none.length > 0 && (
        <s-section heading="No proposal: the estimator declined">
          <s-stack direction="block" gap="base">
            <s-paragraph>
              The estimator refused to propose a price for these, so the policy never saw them.
            </s-paragraph>
            <NoProposalTable rows={none} />
          </s-stack>
        </s-section>
      )}
    </>
  );
}
