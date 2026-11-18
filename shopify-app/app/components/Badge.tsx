import type { ReactNode } from "react";
import type { BadgeTone } from "./format";

// Every badge carries its meaning as text; the tone is only reinforcement.
export function Badge({ tone, children }: { tone: BadgeTone; children: ReactNode }) {
  return <s-badge tone={tone}>{children}</s-badge>;
}
