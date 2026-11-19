# Synthetic order history for the development store

PricePilot needs sales history to estimate price elasticity, and a fresh
development store has none. This folder fills the store with **synthetic**
data: 13 coffee-roaster products and 90 days of orders generated from demand
curves whose true elasticities are known (`cmd/seedplan` in the Go module).
None of it is real sales.

## How it is labelled

- `plan.json` has `"synthetic": true` and a `label` field saying so.
- Every seeded order is tagged `pricepilot-synthetic` and `pp-seed-YYYY-MM-DD`
  (the day it stands for). The tag is also what makes a re-run safe.
- Every seeded product is tagged `pricepilot-seed`.
- Orders have no customer and no email. Nothing personal is stored or read.

## Files

| File | What it is |
| --- | --- |
| `plan.json` | The plan: products, 90 days of price and units per product, the policy, and the outcome the engine is expected to produce (`expected`). Generated, do not edit. |
| `policy.json` | Just the enforcer policy from the plan. |
| `seed.mjs` | Creates products and orders in the store. |
| `verify.mjs` | Reads the orders back and compares every (day, product) units and price with the plan. |
| `lib.mjs` | Shared helpers. |
| `verify.test.mjs` | Unit tests for the money conversion and the comparison. |
| `.state.json` | Written by `seed.mjs`: handle to product id and variant id. Local only, git-ignored. |

Node 22, no npm dependencies. The scripts call the `shopify` CLI, so run them
from `shopify-app/` with Node 22 on the PATH:

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd shopify-app
```

## Commands, in order

```sh
# 1. Look first. Read-only: lists what it would create, sends nothing.
node seed/seed.mjs --plan seed/plan.json --store your-dev-store.myshopify.com --dry-run

# 2. Seed products, then orders (about 20 minutes: see below).
node seed/seed.mjs --plan seed/plan.json --store your-dev-store.myshopify.com

# 3. Read everything back and compare it with the plan.
node seed/verify.mjs --plan seed/plan.json --store your-dev-store.myshopify.com
```

Step 3 prints `90 days x 13 products match the plan` and exits 0 on success.
On any difference it lists each one and exits 1. Before step 2 it prints
`0 seeded days found` and exits 1.

Options for `seed.mjs`: `--products-only` stops after the products;
`--days N` seeds only the first N (oldest) days; `--dry-run` sends nothing.

## How long it takes

A dev store allows at most 5 `orderCreate` calls a minute, so the script waits
13 seconds between orders: about 13 s a day, 90 days, roughly 20 minutes. A
throttled or failed call is retried up to 3 times with growing waits; before a
retry it checks whether the order was in fact created. A persistent error
stops the run with a clear message and a non-zero exit.

## Re-running

Safe at any time. Products are found by handle and left alone when price, cost
and SKU already match. Before creating a day it looks for an order tagged
`pp-seed-<that day>` and skips it if one exists. So after an interruption, run
the same command again and it carries on from the first missing day.

To change the data, regenerate the plan with a new run date (history is the 90
days ending the day before it):

```sh
go run ./cmd/seedplan -end YYYY-MM-DD -out shopify-app/seed/plan.json
```

Seeding a different plan on top of an old one is not supported: the day tags
would match and the old orders would be skipped. Delete the old seed orders
first.

## Re-seed before a demo

An app with the `read_orders` scope can read orders only for about **60 days
after they are created**. Seeded orders carry past `processedAt` dates but are
created on the day you run the script, so they stop being readable roughly 60
days later. Seed shortly before a demo, then run `verify.mjs` to confirm.

## Cleanup

`#1001` (tagged `pp-probe` and `pricepilot-synthetic`) and two
"LIVE TEST Probe Coffee" products are leftovers from earlier live tests, not
seed data. `verify.mjs` reports and ignores orders that have no `pp-seed-` tag.
