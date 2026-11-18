import type { Policy } from "../services/types";
import {
  batchBudgetText,
  exclusionsText,
  formatBp,
  hardBoundsText,
  marginFloorText,
  roundingText,
  ruleLabel,
  velocityText,
} from "./format";
import { dlGrid, mono, subdued, wrap } from "./styles";

// Each setting names the engine rule ids it controls, because the engine's
// reasons name rules by id ("... or relax margin_floor"); the id is how a
// merchant connects a reason to the setting behind it.
function Item({
  label,
  rules = [],
  children,
}: {
  label: string;
  rules?: string[];
  children: React.ReactNode;
}) {
  return (
    <div style={wrap}>
      <dt>
        <s-text color="subdued">{label}</s-text>
        {rules.length > 0 && (
          <>
            {" "}
            <small style={{ ...mono, ...subdued }}>
              {rules.map((r, i) => (
                <span key={r} title={ruleLabel(r)}>
                  {i > 0 && ", "}
                  {r}
                </span>
              ))}
            </small>
          </>
        )}
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

/** Read-only: the rules that decided this run. No editing here. */
export function PolicyPanel({ policy, policyHash }: { policy: Policy; policyHash: string }) {
  return (
    <s-section heading="Policy in force">
      <s-stack direction="block" gap="base">
        <s-paragraph>
          <span style={mono}>{policy.id}</span> version {policy.version}. Read-only: these are
          the rules every proposal is checked against. The grey names are the rule ids the
          engine uses in its reasons.
        </s-paragraph>
        <dl style={dlGrid}>
          <Item label="Margin floor" rules={["margin_floor"]}>
            {marginFloorText(policy)}
          </Item>
          <Item label="Largest decrease per run" rules={["max_decrease"]}>
            {formatBp(policy.max_decrease_bp)}
          </Item>
          <Item label="Largest increase per run" rules={["max_increase"]}>
            {formatBp(policy.max_increase_bp)}
          </Item>
          <Item label="Price ending" rules={["rounding"]}>
            {roundingText(policy)}
          </Item>
          <Item label="Smallest change worth applying" rules={["min_change"]}>
            {formatBp(policy.min_change_bp)}
          </Item>
          <Item label="Minimum confidence" rules={["min_confidence"]}>
            {formatBp(policy.min_confidence_bp)}
          </Item>
          <Item label="Velocity" rules={["velocity_min_days", "velocity_max_changes"]}>
            {velocityText(policy)}
          </Item>
          <Item label="Exclusions" rules={["excluded"]}>
            {exclusionsText(policy)}
          </Item>
          <Item label="Hard floor and ceiling" rules={["hard_floor", "hard_ceiling"]}>
            {hardBoundsText(policy)}
          </Item>
          <Item label="Products changed per run" rules={["batch_change_budget"]}>
            {batchBudgetText(policy)}
          </Item>
          <Item label="Respect minimum advertised price" rules={["map"]}>
            {policy.respect_map ? "Yes" : "No"}
          </Item>
          <Item label="Policy hash">
            <code style={mono}>{policyHash}</code>
          </Item>
        </dl>
      </s-stack>
    </s-section>
  );
}
