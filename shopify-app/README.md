# PricePilot: Shopify admin app

An embedded Shopify admin app that reviews a store's prices. A run reads the
catalog and recent order history, asks the Go pricing engine (the module at
the repository root) for elasticity estimates, proposals and policy decisions,
and shows each product as held back, adjusted by a guardrail, accepted, or
without a proposal, with the engine's reasons. Nothing is written until the
merchant applies the run; an applied run can be rolled back to the exact prior
prices.

Built with React Router 7, Polaris web components, Prisma with SQLite, and
vitest.

## Run it

Requirements: Node 22.15 or later, Go 1.26, the Shopify CLI, and a development
store.

```sh
npm install
npm run engine:build   # builds the Go engine into .engine/engine
shopify app dev
```

`shopify app dev` also rebuilds the engine and runs `prisma generate` before it
starts (`shopify.web.toml`), then applies migrations with
`prisma migrate deploy`. The engine binary path can be overridden with
`PRICEPILOT_ENGINE`.

In development, `/app/preview?state=preview` renders the screens from typed
fixtures with no authentication and no server calls (`app/routes/app_.preview.tsx`;
the states are listed at the top of the page). It returns 404 in production.

## Access scopes

| Scope | Why |
| --- | --- |
| `write_products` | Read products, variants, prices, unit costs, inventory quantities, tags and product types; write variant prices when a run is applied or rolled back. |
| `read_orders` | Read order dates and line items (variant, quantity, unit price) to estimate how demand responds to price. |
| `write_orders` | Only for `seed/seed.mjs`, which creates the synthetic order history on a development store. The app itself never writes orders. |

Orders are protected customer data. The app needs **Level 1** access and
requests no Level 2 fields: no customer name, email, phone number or address
(the orders query asks for none of them, and not even the order id). The
review screen's "Data this app reads" section states exactly what is read and
kept; its sources are listed in `app/components/DataSection.tsx`.

## Synthetic order history

A new development store has no sales. `seed/README.md` explains how to fill it
with synthetic orders generated from known demand curves, how they are
labelled, and how to verify them. When every order a run reads is synthetic,
the review screen says so and shows the true elasticity next to each estimate.

## Tests

```sh
npm test            # vitest; builds the Go engine first, so Go must be installed
npm run typecheck
npm run lint
```

The service tests run against a throwaway SQLite database built from the real
migrations, an in-memory fake of the Admin GraphQL API, and the real engine
binary.

## No pricing logic in TypeScript

TypeScript never computes or adjusts a price or a decision. It reads,
aggregates, stores, displays, and writes the engine's `final_price`.

- `app/services/engine.server.ts` is the boundary: it spawns the engine and
  exchanges one JSON request and response per call (`estimate`, `decide`,
  `policy_hash`). If the binary is missing it fails; there is no fallback.
- `app/services/review.server.ts` builds the engine's inputs from Shopify data
  and writes only `final_price` values it received.
- `app/services/rows.ts` groups decisions for display by mirroring the
  engine's own `Decision.BoundByPolicy()` (`enforcer/decision.go`).
- `app/components/format.ts` only turns integer cents and basis points into
  text.

## Interrupted writes

Applying or rolling back stores a plan of every variant (from and to price)
before the first mutation and refreshes a heartbeat after every chunk. If the
process dies part-way, the run stays `APPLYING` or `ROLLING_BACK`; after two
minutes without a heartbeat the review screen shows it as interrupted and
offers one action, "Check what was written". That reads each planned variant's
live price and records what landed (`recoverRun` in `review.server.ts`). A
rollback that could not restore every price can be retried for the rest.

## Known limits

- Orders with more than 50 line items are truncated to the first 50, with a
  warning in the server log.
- Orders are read page by page through the Admin GraphQL API. A large store
  would need bulk operations instead.
- `read_orders` returns orders created in about the last 60 days, counted from
  when Shopify created the order, not from the order's own date. Seeded orders
  dated 90 days back are readable (checked on the dev store on 2026-11-18), but
  on a real store history older than 60 days would need `read_all_orders`,
  which the app does not request.
- Prices are the variant's base price. Stores that use Markets or B2B price
  lists have other prices this app neither reads nor writes.
- The velocity rule (minimum days between changes, changes per window) counts
  only the price changes this app logged. Changes made in the Shopify admin or
  by other apps are not seen.
