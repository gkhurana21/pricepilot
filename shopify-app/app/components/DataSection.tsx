// What the app reads, stores and computes, stated exactly, because this is what
// was declared to Shopify. Each line is checked against the code:
//   reads        services/catalog.server.ts (VARIANTS_QUERY, ORDERS_QUERY, PRICES_QUERY)
//   writes       services/catalog.server.ts (UPDATE_MUTATION: variant price only)
//   stores       prisma/schema.prisma (Session, PolicyRecord, Run, PriceChange)
//   aggregates   services/observations.ts (daily units and prices per variant)
//   computes     services/engine.server.ts (spawns the Go engine on the app server)
// Change the text and the code together.

export const DATA_SECTION_ID = "data-this-app-reads";

export function DataSection() {
  return (
    <div id={DATA_SECTION_ID}>
      <s-section heading="Data this app reads">
        <s-unordered-list>
          <s-list-item>
            From your catalog: products and their variants, with titles, SKU codes, prices,
            unit costs, inventory quantities, tags, product types and status.
          </s-list-item>
          <s-list-item>
            From orders processed in the last 100 days: the date, whether the order was
            cancelled, its tags, and each line item&apos;s variant, quantity and unit price
            (before and after discounts). These are used only to estimate how sensitive
            demand is to price.
          </s-list-item>
          <s-list-item>
            It requests no customer names, email addresses, phone numbers or addresses, and
            no order numbers.
          </s-list-item>
          <s-list-item>
            Order data is aggregated in memory into units sold and prices per variant per
            day, and discarded when the run is decided. The app stores no order or customer
            records: only its own runs (per-product estimates and decisions, the number of
            orders read and the dates they span), the policy, a log of the price changes it
            made, and the access session Shopify issues for your store.
          </s-list-item>
          <s-list-item>
            Estimates and decisions are computed by the Go pricing engine, which runs on the
            app&apos;s server. No store data is sent to any other service.
          </s-list-item>
          <s-list-item>
            It writes only variant prices, and only when you apply or roll back a run.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </div>
  );
}
