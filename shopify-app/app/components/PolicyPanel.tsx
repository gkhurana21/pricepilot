import type { Policy } from "../services/types";
import {
  exclusionsText,
  formatBp,
  formatCents,
  marginFloorText,
  roundingText,
  velocityText,
} from "./format";
import { dlGrid, mono, wrap } from "./styles";

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={wrap}>
      <dt>
        <s-text color="subdued">{label}</s-text>
      </dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

/** Read-only: the rules that decided this run. No editing here. */
export function PolicyPanel({ policy, policyHash }: { policy: Policy; policyHash: string }) {
  return (
    <s-section heading="Policy in force">
      <s-paragraph>
        <span style={mono}>{policy.id}</span> version {policy.version}. Read-only: these are
        the rules every proposal is checked against.
      </s-paragraph>
      <dl style={dlGrid}>
        <Item label="Margin floor">{marginFloorText(policy)}</Item>
        <Item label="Largest decrease per run">{formatBp(policy.max_decrease_bp)}</Item>
        <Item label="Largest increase per run">{formatBp(policy.max_increase_bp)}</Item>
        <Item label="Price ending">{roundingText(policy)}</Item>
        <Item label="Smallest change worth applying">{formatBp(policy.min_change_bp)}</Item>
        <Item label="Minimum confidence">{formatBp(policy.min_confidence_bp)}</Item>
        <Item label="Velocity">{velocityText(policy)}</Item>
        <Item label="Exclusions">{exclusionsText(policy)}</Item>
        <Item label="Hard floor and ceiling">
          {formatCents(policy.hard_floor)} to {formatCents(policy.hard_ceiling)}
        </Item>
        <Item label="Respect minimum advertised price">{policy.respect_map ? "Yes" : "No"}</Item>
        <Item label="Policy hash">
          <code style={mono}>{policyHash}</code>
        </Item>
      </dl>
    </s-section>
  );
}
