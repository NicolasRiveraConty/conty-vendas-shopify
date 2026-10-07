import { normalizeSignal } from '../domain/attribution.js';
import type { Creator, LedgerEntry, OrderSnapshot } from '../domain/types.js';

/**
 * Persistência da venda. Só acrescenta lançamentos: não há update nem delete.
 * Trocar a memória por SQLite significa implementar esta mesma superfície.
 */
export interface SalesRepository {
  listCreators(): Creator[];
  getOrder(orderId: string): OrderSnapshot | undefined;
  listOrders(): OrderSnapshot[];
  /** Falha se o pedido já foi gravado. O snapshot da venda não muda com estorno. */
  saveOrder(order: OrderSnapshot): void;
  getEventOrderId(eventId: string): string | undefined;
  rememberEvent(eventId: string, orderId: string): void;
  findSale(orderId: string): LedgerEntry | undefined;
  findRefund(refundId: string): LedgerEntry | undefined;
  append(entry: LedgerEntry): void;
  listEntries(orderId: string): LedgerEntry[];
}

export class MemorySalesRepository implements SalesRepository {
  private readonly creators: Creator[];
  private readonly orders = new Map<string, OrderSnapshot>();
  private readonly events = new Map<string, string>();
  private readonly entries: LedgerEntry[] = [];

  constructor(creators: readonly Creator[]) {
    assertUniqueSignals(creators);
    this.creators = creators.map((creator) => ({
      ...creator,
      coupons: [...creator.coupons],
    }));
  }

  listCreators(): Creator[] {
    return this.creators.map((creator) => ({
      ...creator,
      coupons: [...creator.coupons],
    }));
  }

  getOrder(orderId: string): OrderSnapshot | undefined {
    const order = this.orders.get(orderId);
    return order ? structuredClone(order) : undefined;
  }

  listOrders(): OrderSnapshot[] {
    return [...this.orders.values()].map((order) => structuredClone(order));
  }

  saveOrder(order: OrderSnapshot): void {
    if (this.orders.has(order.orderId)) {
      throw new Error(`Pedido ${order.orderId} já existe.`);
    }
    this.orders.set(order.orderId, structuredClone(order));
  }

  getEventOrderId(eventId: string): string | undefined {
    return this.events.get(eventId);
  }

  rememberEvent(eventId: string, orderId: string): void {
    const known = this.events.get(eventId);
    if (known !== undefined && known !== orderId) {
      throw new Error(`Evento ${eventId} já está ligado a outro pedido.`);
    }
    this.events.set(eventId, orderId);
  }

  findSale(orderId: string): LedgerEntry | undefined {
    const entry = this.entries.find((item) => item.orderId === orderId && item.kind === 'sale');
    return entry ? structuredClone(entry) : undefined;
  }

  findRefund(refundId: string): LedgerEntry | undefined {
    const entry = this.entries.find((item) => item.refundId === refundId);
    return entry ? structuredClone(entry) : undefined;
  }

  append(entry: LedgerEntry): void {
    this.entries.push(structuredClone(entry));
  }

  listEntries(orderId: string): LedgerEntry[] {
    return this.entries
      .filter((entry) => entry.orderId === orderId)
      .map((entry) => structuredClone(entry));
  }
}

function assertUniqueSignals(creators: readonly Creator[]): void {
  const coupons = new Set<string>();
  const utms = new Set<string>();

  for (const creator of creators) {
    for (const coupon of creator.coupons) {
      const key = normalizeSignal(coupon);
      if (!key || coupons.has(key)) {
        throw new Error(`Cupom duplicado ou vazio no criador ${creator.id}.`);
      }
      coupons.add(key);
    }

    const utm = normalizeSignal(creator.utmContent);
    if (!utm || utms.has(utm)) {
      throw new Error(`utm_content duplicado ou vazio no criador ${creator.id}.`);
    }
    utms.add(utm);
  }
}
