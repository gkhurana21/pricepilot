// The synthetic-data plan (seed/plan.json), used only to show the true
// elasticity next to the estimate when the orders read are synthetic. Absent
// on any real store, in which case nothing is looked up.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface TrueElasticities {
  byHandle: Map<string, number>;
  bySku: Map<string, number>;
}

/** Reads products[].{handle, sku, true_elasticity} from seed/plan.json, or returns null if the file is absent or unreadable. */
export function loadTrueElasticities(): TrueElasticities | null {
  const file = path.resolve(process.cwd(), "seed", "plan.json");
  if (!existsSync(file)) return null;
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")) as {
      products?: { handle?: string; sku?: string; true_elasticity?: number }[];
    };
    const byHandle = new Map<string, number>();
    const bySku = new Map<string, number>();
    for (const p of plan.products ?? []) {
      if (typeof p.true_elasticity !== "number") continue;
      if (p.handle) byHandle.set(p.handle, p.true_elasticity);
      if (p.sku) bySku.set(p.sku, p.true_elasticity);
    }
    return { byHandle, bySku };
  } catch {
    return null;
  }
}
