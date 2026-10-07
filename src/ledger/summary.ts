import type { LedgerEntry, OrderSnapshot, OrderSummary } from '../domain/types.js';

export function summarizeOrder(order: OrderSnapshot, entries: LedgerEntry[]): OrderSummary {
  const grossCents = sum(entries, 'sale');
  const refundedCents = sum(entries, 'refund');
  const netCents = Math.max(0, grossCents - refundedCents);
  const creditedCents = order.attribution.creatorId ? netCents : 0;

  return {
    orderId: order.orderId,
    currency: order.currency,
    status: order.status,
    couponCode: order.couponCode,
    utm: order.utm,
    attribution: order.attribution,
    grossCents,
    refundedCents,
    netCents,
    creditedCents,
    reversed: order.attribution.creatorId !== null && refundedCents > 0 && netCents === 0,
    entries,
  };
}

export type CreatorSaleLine = {
  orderId: string;
  source: OrderSnapshot['attribution']['source'];
  couponWonTie: boolean;
  grossCents: number;
  refundedCents: number;
  creditedCents: number;
  reversed: boolean;
};

export function summarizeCreator(
  creatorId: string,
  orders: OrderSnapshot[],
  entriesOf: (orderId: string) => LedgerEntry[],
): { creatorId: string; creditedCents: number; orders: CreatorSaleLine[] } {
  const lines = orders
    .filter((order) => order.attribution.creatorId === creatorId)
    .map((order) => {
      const summary = summarizeOrder(order, entriesOf(order.orderId));
      return {
        orderId: order.orderId,
        source: order.attribution.source,
        couponWonTie: order.attribution.couponWonTie,
        grossCents: summary.grossCents,
        refundedCents: summary.refundedCents,
        creditedCents: summary.creditedCents,
        reversed: summary.reversed,
      };
    });

  return {
    creatorId,
    creditedCents: lines.reduce((total, line) => total + line.creditedCents, 0),
    orders: lines,
  };
}

function sum(entries: LedgerEntry[], kind: LedgerEntry['kind']): number {
  return entries.reduce((total, entry) => (entry.kind === kind ? total + entry.amountCents : total), 0);
}
