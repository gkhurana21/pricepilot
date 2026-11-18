// Dev-only: renders the same screens as /app and /app/history from fixtures,
// with no authentication and no server calls, so the UI can be opened in a
// plain browser. The trailing underscore in the file name opts this route out
// of the authenticated `app` layout while keeping the URL /app/preview.
//
//   /app/preview?state=preview|applied|partial|rolledback|empty|history

import { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { ReviewScreen } from "../components/ReviewScreen";
import { HistoryScreen } from "../components/HistoryScreen";
import { fixtureRuns, type FixtureState } from "../fixtures/runs";
import { fixtureRunList } from "../fixtures/history";

const STATES = [...Object.keys(fixtureRuns), "history"] as const;
type PreviewState = (typeof STATES)[number];

export const loader = ({ request }: LoaderFunctionArgs) => {
  // eslint-disable-next-line no-undef
  if (process.env.NODE_ENV === "production") {
    throw new Response("Not Found", { status: 404 });
  }
  const asked = new URL(request.url).searchParams.get("state") ?? "preview";
  const state: PreviewState = (STATES as readonly string[]).includes(asked)
    ? (asked as PreviewState)
    : "preview";
  return { state };
};

export default function Preview() {
  const { state } = useLoaderData<typeof loader>();
  const [notice, setNotice] = useState<string | null>(null);
  const say = () => setNotice("Preview fixture: buttons do nothing here and no server is called.");

  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris-2.js" />
      <nav aria-label="Fixture states" style={{ padding: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <strong>Fixture:</strong>
        {STATES.map((s) => (
          <a key={s} href={`/app/preview?state=${s}`} aria-current={s === state ? "page" : undefined}>
            {s}
          </a>
        ))}
      </nav>
      {state === "history" ? (
        <HistoryScreen
          runs={fixtureRunList}
          error={null}
          hrefFor={(id) => `/app/preview?state=${runState(id)}`}
        />
      ) : (
        <ReviewScreen
          run={fixtureRuns[state as FixtureState]}
          policy={null}
          busy={null}
          error={null}
          notice={notice}
          onCreate={say}
          onApply={say}
          onRollback={say}
        />
      )}
    </>
  );
}

function runState(id: string): FixtureState {
  if (id.includes("APPLIED")) return "applied";
  if (id.includes("PARTIAL")) return "partial";
  if (id.includes("ROLLED")) return "rolledback";
  return "preview";
}
