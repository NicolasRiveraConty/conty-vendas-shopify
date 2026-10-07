import { randomUUID } from 'node:crypto';
import { attributeSale } from '../domain/attribution.js';
import type { LedgerEntry, OrderSnapshot, OrderSummary, UtmParams } from '../domain/types.js';
import type { SalesRepository } from '../ledger/repository.js';
import { summarizeOrder } from '../ledger/summary.js';
import { IngestError } from '../errors.js';

export type SaleCommand = {
  eventId: string;
  orderId: string;
  totalCents: number;
  currency: string;
  status: string;
  couponCode: string | null;
  utm: UtmParams;
};

export type RefundCommand = {
  eventId: string;
  refundId: string;
  orderId: string;
  amountCents: number;
  currency: string | null;
};

export type IngestOutcome = {
  duplicate: boolean;
  reason?: 'event_already_processed' | 'order_already_ingested' | 'refund_already_ingested';
  orderId: string;
  summary: OrderSummary;
};

/**
 * Grava a venda uma única vez e congela a atribuição.
 * Uma nova entrega do mesmo evento, ou o mesmo pedido com outro id de evento,
 * não cria outra linha de venda.
 */
export function ingestSale(repository: SalesRepository, command: SaleCommand, now = new Date()): IngestOutcome {
  const replay = duplicateEvent(repository, command.eventId);
  if (replay) return replay;

  const existingSale = repository.findSale(command.orderId);
  if (existingSale) {
    repository.rememberEvent(command.eventId, command.orderId);
    return outcome(repository, command.orderId, true, 'order_already_ingested');
  }

  const attribution = attributeSale(
    { couponCode: command.couponCode, utmContent: command.utm.content },
    repository.listCreators(),
  );
  const recordedAt = now.toISOString();

  const order: OrderSnapshot = {
    orderId: command.orderId,
    currency: command.currency,
    status: command.status,
    couponCode: command.couponCode,
    utm: command.utm,
    attribution,
    recordedAt,
  };

  const entry: LedgerEntry = {
    id: randomUUID(),
    eventId: command.eventId,
    orderId: command.orderId,
    kind: 'sale',
    amountCents: command.totalCents,
    currency: command.currency,
    refundId: null,
    creatorId: attribution.creatorId,
    source: attribution.source,
    recordedAt,
  };

  repository.saveOrder(order);
  repository.append(entry);
  repository.rememberEvent(command.eventId, command.orderId);

  return outcome(repository, command.orderId, false);
}

/**
 * Acrescenta um estorno. Não apaga a venda nem recalcula o criador.
 * O saldo creditado é derivado do ledger; estorno total deixa esse saldo em zero.
 */
export function ingestRefund(
  repository: SalesRepository,
  command: RefundCommand,
  now = new Date(),
): IngestOutcome {
  const replay = duplicateEvent(repository, command.eventId);
  if (replay) return replay;

  const existingRefund = repository.findRefund(command.refundId);
  if (existingRefund) {
    repository.rememberEvent(command.eventId, existingRefund.orderId);
    return outcome(repository, existingRefund.orderId, true, 'refund_already_ingested');
  }

  const order = repository.getOrder(command.orderId);
  if (!order) {
    throw new IngestError(404, 'order_not_found', 'Não há venda ingerida para este pedido.');
  }
  if (command.currency && command.currency !== order.currency) {
    throw new IngestError(422, 'currency_mismatch', 'A moeda do estorno difere da venda.');
  }

  const entry: LedgerEntry = {
    id: randomUUID(),
    eventId: command.eventId,
    orderId: command.orderId,
    kind: 'refund',
    amountCents: command.amountCents,
    currency: order.currency,
    refundId: command.refundId,
    creatorId: order.attribution.creatorId,
    source: order.attribution.source,
    recordedAt: now.toISOString(),
  };

  repository.append(entry);
  repository.rememberEvent(command.eventId, command.orderId);

  return outcome(repository, command.orderId, false);
}

function duplicateEvent(repository: SalesRepository, eventId: string): IngestOutcome | undefined {
  const orderId = repository.getEventOrderId(eventId);
  if (!orderId) return undefined;
  return outcome(repository, orderId, true, 'event_already_processed');
}

function outcome(
  repository: SalesRepository,
  orderId: string,
  duplicate: boolean,
  reason?: IngestOutcome['reason'],
): IngestOutcome {
  const order = repository.getOrder(orderId);
  if (!order) {
    throw new IngestError(404, 'order_not_found', 'Pedido não encontrado.');
  }
  return {
    duplicate,
    reason,
    orderId,
    summary: summarizeOrder(order, repository.listEntries(orderId)),
  };
}
