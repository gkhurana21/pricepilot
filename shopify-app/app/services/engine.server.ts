// Client for the Go pricing engine (cmd/engine). Every estimate, proposal and
// decision comes from this binary; TypeScript never decides a price, and if the
// binary is missing this module fails loudly instead of falling back.
//
// Protocol: spawn the binary, write ONE request {op, in} to stdin, close it,
// read ONE JSON line from stdout: {ok:true,out} or {ok:false,error}.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type {
  DecideResult,
  EstimateResult,
  Policy,
  Proposal,
  SKUState,
} from "./types";

export type EngineOp = "estimate" | "decide" | "policy_hash";

export const ENGINE_TIMEOUT_MS = 15_000;

export interface CallOptions {
  /** Override the binary path (tests). Default: env PRICEPILOT_ENGINE. */
  binary?: string;
  timeoutMs?: number;
}

/** Where the engine binary lives: PRICEPILOT_ENGINE, else .engine/engine under the app root. */
export function enginePath(): string {
  return (
    process.env.PRICEPILOT_ENGINE ||
    path.resolve(process.cwd(), ".engine", "engine")
  );
}

export async function callEngine<T = unknown>(
  op: EngineOp,
  payload: unknown,
  options: CallOptions = {},
): Promise<T> {
  const binary = options.binary ?? enginePath();
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    throw new Error(
      `The pricing engine binary was not found at ${binary}. ` +
        `Build it with "npm run engine:build" (needs Go), or set PRICEPILOT_ENGINE to its path.`,
    );
  }

  const timeoutMs = options.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const request = JSON.stringify({ op, in: payload });

  return new Promise<T>((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(new Error(`The pricing engine timed out after ${timeoutMs} ms (op ${op}).`)),
      );
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    // The engine may exit before reading all of stdin (it already failed).
    child.stdin.on("error", () => undefined);
    child.on("error", (err) =>
      finish(() => reject(new Error(`Could not start the pricing engine: ${err.message}`))),
    );
    child.on("close", (code) => {
      finish(() => {
        const line = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (!line) {
          reject(
            new Error(
              `The pricing engine produced no output (exit ${code}). ${stderr.trim()}`.trim(),
            ),
          );
          return;
        }
        let parsed: { ok?: boolean; out?: T; error?: string };
        try {
          parsed = JSON.parse(line);
        } catch {
          reject(new Error(`The pricing engine returned invalid JSON (exit ${code}): ${line.slice(0, 200)}`));
          return;
        }
        if (parsed.ok) {
          resolve(parsed.out as T);
        } else {
          reject(new Error(parsed.error || `The pricing engine failed (exit ${code}).`));
        }
      });
    });

    child.stdin.end(request);
  });
}

export interface EstimateSku {
  sku: SKUState;
  group: string;
  observations: { day: number; price: number; units: number; on_promo: boolean }[];
}

export function estimate(
  skus: EstimateSku[],
  options?: CallOptions,
): Promise<EstimateResult> {
  return callEngine<EstimateResult>("estimate", { skus }, options);
}

export interface DecideRequest {
  policy: Policy;
  now: string; // RFC 3339
  items: { sku: SKUState; proposal: Proposal }[];
}

export function decide(
  request: DecideRequest,
  options?: CallOptions,
): Promise<DecideResult> {
  return callEngine<DecideResult>("decide", request, options);
}

/** The engine's hash of a policy ("sha256:<16 hex>"). Never computed in TS. */
export async function policyHash(
  policy: Policy,
  options?: CallOptions,
): Promise<string> {
  const out = await callEngine<{ policy_hash: string }>("policy_hash", policy, options);
  return out.policy_hash;
}
