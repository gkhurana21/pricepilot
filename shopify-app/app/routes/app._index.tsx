import { useEffect } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useNavigate, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  applyRun,
  createRun,
  findUnfinishedWrite,
  getLatestRun,
  getPolicy,
  getRun,
  recoverRun,
  rollbackRun,
} from "../services/review.server";
import type { Policy, RunView } from "../services/types";
import { ReviewScreen, type Intent } from "../components/ReviewScreen";

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface LoaderData {
  run: RunView | null;
  policy: { policy: Policy; policyHash: string } | null;
  error: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderData> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const runId = new URL(request.url).searchParams.get("run");

  let run: RunView | null = null;
  let error: string | null = null;
  try {
    // An unfinished write comes first: until it is reconciled, prices on
    // Shopify may be partly changed, whichever run the merchant opened last.
    run = runId
      ? await getRun(shop, runId)
      : ((await findUnfinishedWrite(shop)) ?? (await getLatestRun(shop)));
    if (runId && !run) error = "That run could not be found.";
  } catch (e) {
    error = messageOf(e);
  }

  let policy: LoaderData["policy"] = null;
  try {
    policy = await getPolicy(shop);
  } catch (e) {
    error = error ?? messageOf(e);
  }

  return { run, policy, error };
};

type ActionData =
  | { ok: true; intent: Intent; runId: string; message: string }
  | { ok: false; intent: string; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const runId = String(form.get("runId") ?? "");
  try {
    if (intent === "create") {
      const run = await createRun(admin.graphql, session.shop);
      return { ok: true, intent, runId: run.id, message: "Preview created" };
    }
    if (intent === "apply" && runId) {
      const run = await applyRun(admin.graphql, session.shop, runId);
      const message =
        run.status === "APPLIED"
          ? "Price changes applied"
          : run.status === "PARTIAL"
            ? "Price changes partly applied"
            : "No price could be applied";
      return { ok: true, intent, runId: run.id, message };
    }
    if (intent === "rollback" && runId) {
      const run = await rollbackRun(admin.graphql, session.shop, runId);
      return {
        ok: true,
        intent,
        runId: run.id,
        message: run.status === "ROLLED_BACK" ? "Run rolled back" : "Run partly rolled back",
      };
    }
    if (intent === "recover" && runId) {
      const run = await recoverRun(admin.graphql, session.shop, runId);
      return { ok: true, intent, runId: run.id, message: "Checked what was written" };
    }
    return { ok: false, intent, error: "Unknown action." };
  } catch (e) {
    return { ok: false, intent, error: messageOf(e) };
  }
};

export default function Index() {
  const { run, policy, error: loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const submittedIntent = fetcher.formData?.get("intent");
  const busy: Intent | null =
    fetcher.state !== "idle" &&
    (submittedIntent === "create" ||
      submittedIntent === "apply" ||
      submittedIntent === "rollback" ||
      submittedIntent === "recover")
      ? submittedIntent
      : null;

  const result = fetcher.data;
  useEffect(() => {
    if (result?.ok) {
      shopify.toast.show(result.message);
      // A new preview is always the latest run; leave any ?run= view.
      if (result.intent === "create" && params.get("run")) navigate("/app");
    }
  }, [result, shopify, navigate, params]);

  const submit = (intent: Intent) =>
    fetcher.submit({ intent, runId: run?.id ?? "" }, { method: "POST" });

  const actionError = result && !result.ok ? result.error : null;

  return (
    <ReviewScreen
      run={run}
      policy={policy}
      busy={busy}
      error={actionError ?? loadError}
      onCreate={() => submit("create")}
      onApply={() => submit("apply")}
      onRollback={() => submit("rollback")}
      onRecover={() => submit("recover")}
    />
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
