import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listRuns } from "../services/review.server";
import type { RunListItem } from "../services/types";
import { HistoryScreen } from "../components/HistoryScreen";

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<{ runs: RunListItem[]; error: string | null }> => {
  const { session } = await authenticate.admin(request);
  try {
    return { runs: await listRuns(session.shop), error: null };
  } catch (e) {
    return { runs: [], error: e instanceof Error ? e.message : String(e) };
  }
};

export default function History() {
  const { runs, error } = useLoaderData<typeof loader>();
  return <HistoryScreen runs={runs} error={error} hrefFor={(id) => `/app?run=${id}`} />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
