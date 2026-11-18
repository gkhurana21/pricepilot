// The active pricing policy per shop. A policy is data: the default comes from
// seed/policy.json when that file exists, else from the built-in below. The
// hash always comes from the Go engine's policy_hash op, never from TypeScript.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import prisma from "../db.server";
import { policyHash } from "./engine.server";
import type { Policy } from "./types";

/** Same shape as the Go enforcer.Policy. */
export const BUILT_IN_POLICY: Policy = {
  id: "pricepilot-default",
  version: 1,
  margin_floor: { basis: "on_price", rate: 4000, absolute_floor: 0 },
  respect_map: false,
  max_decrease_bp: 1500,
  max_increase_bp: 1000,
  hard_floor: 0,
  hard_ceiling: 0,
  velocity: { min_days_between_changes: 14, max_changes_per_window: 2, window_days: 90 },
  exclusions: { sku_ids: [], tags: ["subscription"], collections: [] },
  rounding: { modulus: 100, residue: 99, enabled: true },
  min_change_bp: 200,
  min_confidence_bp: 6000,
  max_skus_changed_bp: 10000,
};

/** seed/policy.json (relative to the app root) when present, else the built-in policy. */
export function loadDefaultPolicy(): Policy {
  const file = path.resolve(process.cwd(), "seed", "policy.json");
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Policy;
    if (parsed && typeof parsed === "object" && parsed.margin_floor && parsed.velocity) {
      return parsed;
    }
    throw new Error(`${file} is not a pricing policy (missing margin_floor or velocity)`);
  }
  return structuredClone(BUILT_IN_POLICY);
}

/** The policy in force for a shop, and its hash as computed by the Go engine. */
export async function getPolicy(
  shop: string,
): Promise<{ policy: Policy; policyHash: string }> {
  const record = await prisma.policyRecord.findFirst({
    where: { shop },
    orderBy: { createdAt: "desc" },
  });
  if (record) {
    return { policy: JSON.parse(record.json) as Policy, policyHash: record.hash };
  }
  const policy = loadDefaultPolicy();
  const hash = await policyHash(policy);
  await prisma.policyRecord.create({
    data: { shop, json: JSON.stringify(policy), hash, version: policy.version },
  });
  return { policy, policyHash: hash };
}
