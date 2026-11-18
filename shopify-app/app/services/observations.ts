// Turns order lines into the engine's per-day observations. Pure: no I/O.
//
// This is aggregation, not pricing. The engine needs one Observation per
// calendar day (UTC), including days nothing sold (units 0), because leaving
// zero days out overstates volume and defeats its volume gate.

import type { Cents, Observation } from "./types";

export interface OrderLine {
  variantId: string;
  processedAt: string; // ISO 8601
  quantity: number;
  unitPriceCents: Cents; // original unit price on the line
  discountedUnitPriceCents: Cents; // after all discounts
}

export interface DayRange {
  startDay: number; // inclusive, days since 1970-01-01 UTC
  endDay: number; // inclusive
}

const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 UTC for an ISO timestamp (or Date). */
export function dayIndex(at: string | Date): number {
  const ms = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${String(at)}`);
  return Math.floor(ms / MS_PER_DAY);
}

/** YYYY-MM-DD (UTC) for a day index. */
export function dayToDate(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

interface DayAgg {
  // original unit price -> { units, promoUnits }
  prices: Map<Cents, { units: number; promoUnits: number }>;
  units: number;
}

/**
 * One Observation per UTC day for each variant that sold in the range. A
 * variant's series starts on its first day with a sale and runs to
 * range.endDay. Days without sales carry units 0 and the most recent known
 * price before the day.
 *
 * Several prices on one day: the observation's price is the one with the most
 * units sold that day (ties go to the lower price); units is the day's total
 * across all prices. on_promo is true when more than half of the units sold at
 * that dominant price were discounted below it.
 */
export function buildObservations(
  lines: OrderLine[],
  range: DayRange,
): Map<string, Observation[]> {
  const byVariant = new Map<string, Map<number, DayAgg>>();

  for (const line of lines) {
    if (line.quantity <= 0 || line.unitPriceCents <= 0) continue;
    const day = dayIndex(line.processedAt);
    if (day < range.startDay || day > range.endDay) continue;

    let days = byVariant.get(line.variantId);
    if (!days) byVariant.set(line.variantId, (days = new Map()));
    let agg = days.get(day);
    if (!agg) days.set(day, (agg = { prices: new Map(), units: 0 }));

    const at = agg.prices.get(line.unitPriceCents) ?? { units: 0, promoUnits: 0 };
    at.units += line.quantity;
    if (line.discountedUnitPriceCents < line.unitPriceCents) {
      at.promoUnits += line.quantity;
    }
    agg.prices.set(line.unitPriceCents, at);
    agg.units += line.quantity;
  }

  const out = new Map<string, Observation[]>();
  for (const [variantId, days] of byVariant) {
    const soldDays = [...days.keys()].sort((a, b) => a - b);
    const first = soldDays[0];

    const dominant = new Map<number, { price: Cents; onPromo: boolean; units: number }>();
    for (const [day, agg] of days) {
      let bestPrice = 0;
      let best = { units: -1, promoUnits: 0 };
      for (const [price, at] of agg.prices) {
        if (at.units > best.units || (at.units === best.units && price < bestPrice)) {
          bestPrice = price;
          best = at;
        }
      }
      dominant.set(day, {
        price: bestPrice,
        onPromo: best.promoUnits * 2 > best.units,
        units: agg.units,
      });
    }

    // The series starts on the first sale, so a known price always precedes
    // any zero day and "the next known price" is never needed.
    const series: Observation[] = [];
    let lastPrice: Cents = 0;
    for (let day = first; day <= range.endDay; day++) {
      const d = dominant.get(day);
      if (d) {
        lastPrice = d.price;
        series.push({ day, price: d.price, units: d.units, on_promo: d.onPromo });
      } else {
        series.push({ day, price: lastPrice, units: 0, on_promo: false });
      }
    }
    out.set(variantId, series);
  }
  return out;
}
