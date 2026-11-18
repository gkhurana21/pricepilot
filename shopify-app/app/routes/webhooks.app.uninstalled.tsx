import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Everything this app stored about the shop goes with it: runs, the active
  // policy and the price-change log. These deletes are idempotent, so they run
  // even when the session is already gone.
  await db.$transaction([
    db.run.deleteMany({ where: { shop } }),
    db.policyRecord.deleteMany({ where: { shop } }),
    db.priceChange.deleteMany({ where: { shop } }),
  ]);

  return new Response();
};
