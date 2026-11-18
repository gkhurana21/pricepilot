// A small synthetic store shared by the review-flow tests.
import { addHistory, FakeAdmin } from "./fake-admin";
import type { FakeVariant } from "./fake-admin";

export const SHOP = "test-shop.myshopify.com";

export const V = {
  ethiopia: "gid://shopify/ProductVariant/101",
  colombia: "gid://shopify/ProductVariant/102",
  subscription: "gid://shopify/ProductVariant/103",
  flat: "gid://shopify/ProductVariant/104",
  noCost: "gid://shopify/ProductVariant/105",
  draft: "gid://shopify/ProductVariant/106",
  probe: "gid://shopify/ProductVariant/107",
};

function variant(
  id: string,
  handle: string,
  price: string,
  cost: string | null,
  extra: Partial<FakeVariant["product"]> = {},
): FakeVariant {
  return {
    id,
    title: "Default Title",
    sku: `SKU-${handle}`,
    price,
    inventoryQuantity: 50,
    cost,
    product: {
      id: `gid://shopify/Product/${id.split("/").pop()}`,
      title: handle,
      handle,
      productType: "retail-beans",
      tags: [],
      status: "ACTIVE",
      ...extra,
    },
  };
}

// Price blocks of 10 days cycling through a spread of levels, so prices vary
// enough (and not in step with the week) for the estimator to have a signal.
const LEVELS = [2000, 2200, 1800, 2400, 2100, 1900, 2300];
const blocks = (offset: number) => (i: number) => LEVELS[(Math.floor(i / 10) + offset) % LEVELS.length];

export function buildStore(): FakeAdmin {
  const admin = new FakeAdmin();
  admin.addVariant(variant(V.ethiopia, "ethiopia", "20.00", "8.00"));
  admin.addVariant(variant(V.colombia, "colombia", "20.00", "8.00"));
  admin.addVariant(variant(V.subscription, "box", "20.00", "8.00", { tags: ["subscription"] }));
  admin.addVariant(variant(V.flat, "flat", "20.00", "8.00"));
  admin.addVariant(variant(V.noCost, "nocost", "20.00", null));
  admin.addVariant(variant(V.draft, "draft", "20.00", "8.00", { status: "DRAFT" }));
  admin.addVariant(variant(V.probe, "probe", "20.00", "8.00", { tags: ["pricepilot-probe"] }));

  const tags = ["pricepilot-synthetic"];
  const curve = { baseUnits: 120, elasticity: -2, refPrice: 2000, tags };
  addHistory(admin, { ...curve, variantId: V.ethiopia, priceAt: blocks(0), seed: 1 });
  addHistory(admin, { ...curve, variantId: V.colombia, priceAt: blocks(3), seed: 2 });
  addHistory(admin, { ...curve, variantId: V.subscription, priceAt: blocks(1), seed: 3 });
  addHistory(admin, { ...curve, variantId: V.noCost, priceAt: blocks(2), seed: 4 });
  addHistory(admin, { ...curve, variantId: V.flat, priceAt: () => 2000, seed: 5 });
  addHistory(admin, { ...curve, variantId: V.draft, priceAt: blocks(4), seed: 6 });
  addHistory(admin, { ...curve, variantId: V.probe, priceAt: blocks(5), seed: 7 });
  return admin;
}
