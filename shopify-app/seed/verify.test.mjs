import { test } from "node:test";
import assert from "node:assert/strict";
import { moneyToCents, centsToMoney } from "./lib.mjs";
import { compare, utcDay } from "./verify.mjs";

test("moneyToCents handles variable decimals", () => {
  assert.equal(moneyToCents("21.5"), 2150);
  assert.equal(moneyToCents("21"), 2100);
  assert.equal(moneyToCents("21.50"), 2150);
  assert.equal(moneyToCents("21.500"), 2150);
  assert.equal(moneyToCents("0.05"), 5);
  assert.equal(moneyToCents("0.5"), 50);
  assert.equal(moneyToCents("17.99"), 1799);
  assert.equal(moneyToCents("1234567.89"), 123456789);
  assert.equal(moneyToCents("19."), 1900);
});

test("moneyToCents rejects what is not whole cents", () => {
  for (const bad of ["21.505", "abc", "", "-1.00", "1e3", ".5", "1,5", null, 21.5]) {
    assert.throws(() => moneyToCents(bad), undefined, String(bad));
  }
});

test("centsToMoney round-trips", () => {
  for (const c of [0, 5, 50, 99, 100, 1799, 2150, 123456]) assert.equal(moneyToCents(centsToMoney(c)), c);
  assert.equal(centsToMoney(1900), "19.00");
});

// A 3-day, 2-product plan; B sells nothing on day 2.
const plan = {
  currency: "CAD",
  history: { dates: ["2026-01-01", "2026-01-02", "2026-01-03"] },
  products: [
    { handle: "a", prices: [1000, 1100, 1100], units: [5, 6, 7] },
    { handle: "b", prices: [2000, 2000, 2150], units: [1, 0, 2] },
  ],
};
const variants = { "gid://v/a": "a", "gid://v/b": "b" };
const line = (v, q, amount) => ({ currentQuantity: q, variant: { id: `gid://v/${v}` }, originalUnitPriceSet: { shopMoney: { amount, currencyCode: "CAD" } } });
const order = (day, lines, extra = {}) => ({ id: `o${day}`, name: `#${day}`, processedAt: `${day}T15:00:00Z`, tags: ["pricepilot-synthetic", `pp-seed-${day}`], lineItems: { nodes: lines }, ...extra });
const good = () => [
  order("2026-01-01", [line("a", 5, "10"), line("b", 1, "20.0")]),
  order("2026-01-02", [line("a", 6, "11.00")]),
  order("2026-01-03", [line("b", 2, "21.5"), line("a", 7, "11")]),
];

test("compare: a store that matches the plan has no mismatches", () => {
  const r = compare(plan, good(), variants);
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.matchedDays, 3);
  assert.equal(r.seededDays, 3);
});

test("compare: reports wrong units, wrong price, missing line and unexpected line", () => {
  const o = good();
  o[0].lineItems.nodes[0].currentQuantity = 4; // units
  o[1].lineItems.nodes[0].originalUnitPriceSet.shopMoney.amount = "11.01"; // price
  o[2].lineItems.nodes.pop(); // missing a line for a
  o[1].lineItems.nodes.push(line("b", 3, "20")); // b sold nothing that day
  const r = compare(plan, o, variants);
  assert.equal(r.matchedDays, 0);
  const text = r.mismatches.join("\n");
  assert.match(text, /2026-01-01: a: units 4, plan 5/);
  assert.match(text, /2026-01-02: a: price 1101 cents, plan 1100/);
  assert.match(text, /2026-01-03: a: missing line/);
  assert.match(text, /2026-01-02: b: store has 3 units, plan has none/);
});

test("compare: missing day, duplicate day, off-plan day and a wrong processedAt", () => {
  const o = good();
  o.pop(); // day 3 missing
  o.push(order("2026-01-01", [line("a", 5, "10")], { name: "#dup" }));
  o.push(order("2026-02-01", [line("a", 5, "10")]));
  o[1].processedAt = "2026-01-05T15:00:00Z";
  const text = compare(plan, o, variants).mismatches.join("\n");
  assert.match(text, /2026-01-03: no order in the store/);
  assert.match(text, /2026-01-01: 2 orders/);
  assert.match(text, /2026-02-01: order in the store for a day that is not in the plan/);
  assert.match(text, /2026-01-02: #2026-01-02 processedAt/);
});

test("compare: an unknown variant and a duplicate line are reported", () => {
  const o = good();
  o[0].lineItems.nodes.push(line("zzz", 1, "5"));
  o[0].lineItems.nodes.push(line("a", 1, "10"));
  const text = compare(plan, o, variants).mismatches.join("\n");
  assert.match(text, /unknown variant gid:\/\/v\/zzz/);
  assert.match(text, /two lines for a/);
});

test("compare: orders without a pp-seed tag (the probe order) are ignored, not mismatches", () => {
  const probe = { id: "p", name: "#1001", processedAt: "2026-01-02T15:00:00Z", tags: ["pp-probe", "pricepilot-synthetic"], lineItems: { nodes: [] } };
  const r = compare(plan, [...good(), probe], variants);
  assert.deepEqual(r.mismatches, []);
  assert.deepEqual(r.ignored, ["#1001"]);
});

test("compare: zero seeded days reports every day missing", () => {
  const r = compare(plan, [], variants);
  assert.equal(r.seededDays, 0);
  assert.equal(r.mismatches.length, 3);
});

test("utcDay", () => {
  assert.equal(utcDay("2026-01-02T15:00:00Z"), "2026-01-02");
  assert.equal(utcDay("2026-01-02T23:30:00-05:00"), "2026-01-03");
});
