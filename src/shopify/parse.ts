import { parseMoneyToCents } from '../domain/money.js';
import type { UtmParams } from '../domain/types.js';
import { IngestError } from '../errors.js';

const PAYABLE_STATUSES = new Set(['paid', 'partially_paid', 'partially_refunded']);

export type SaleBody = {
  orderId: string;
  totalCents: number;
  currency: string;
  status: string;
  couponCode: string | null;
  utm: UtmParams;
  payable: boolean;
};

export type RefundBody = {
  refundId: string;
  orderId: string;
  amountCents: number;
  currency: string | null;
};

export function parseSaleBody(topic: string, body: unknown): SaleBody {
  const record = asRecord(body);
  const status = resolveStatus(topic, record);
  const orderId = readId(record.id, 'id');

  if (!PAYABLE_STATUSES.has(status)) {
    return {
      orderId,
      totalCents: 0,
      currency: 'BRL',
      status,
      couponCode: null,
      utm: emptyUtm(),
      payable: false,
    };
  }

  const total = record.total_price ?? record.total;
  return {
    orderId,
    totalCents: parseMoneyToCents(total, 'total_price'),
    currency: readCurrency(record.currency) ?? 'BRL',
    status,
    couponCode: readCoupon(record),
    utm: readUtm(record),
    payable: true,
  };
}

export function parseRefundBody(body: unknown): RefundBody {
  const record = asRecord(body);
  const fromTransactions = readRefundTransactions(record.transactions);
  const amountCents = fromTransactions ?? parseMoneyToCents(record.amount, 'amount');

  if (amountCents <= 0) {
    throw new IngestError(422, 'invalid_refund', 'O estorno precisa de um valor maior que zero.');
  }

  return {
    refundId: readId(record.id, 'id'),
    orderId: readId(record.order_id, 'order_id'),
    amountCents,
    currency: readCurrency(record.currency),
  };
}

function resolveStatus(topic: string, record: Record<string, unknown>): string {
  const raw = record.financial_status ?? record.status;
  if (typeof raw === 'string' && raw.trim()) return raw.trim().toLowerCase();
  return topic === 'orders/paid' ? 'paid' : 'pending';
}

function readCoupon(record: Record<string, unknown>): string | null {
  if (typeof record.coupon === 'string' && record.coupon.trim()) {
    return record.coupon.trim();
  }

  if (!Array.isArray(record.discount_codes)) return null;
  for (const item of record.discount_codes) {
    if (!item || typeof item !== 'object') continue;
    const code = (item as Record<string, unknown>).code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  return null;
}

function readUtm(record: Record<string, unknown>): UtmParams {
  const fromLanding = parseLandingSite(record.landing_site);
  if (!record.utm || typeof record.utm !== 'object') return fromLanding;

  const utm = record.utm as Record<string, unknown>;
  const pick = (key: keyof UtmParams, alias: string): string | null => {
    const explicit = utm[key] ?? utm[alias];
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    return fromLanding[key];
  };

  return {
    source: pick('source', 'utm_source'),
    medium: pick('medium', 'utm_medium'),
    campaign: pick('campaign', 'utm_campaign'),
    content: pick('content', 'utm_content'),
  };
}

function parseLandingSite(value: unknown): UtmParams {
  if (typeof value !== 'string' || !value.trim()) return emptyUtm();
  try {
    const url = new URL(value, 'https://loja.local');
    return {
      source: queryParam(url, 'utm_source'),
      medium: queryParam(url, 'utm_medium'),
      campaign: queryParam(url, 'utm_campaign'),
      content: queryParam(url, 'utm_content'),
    };
  } catch {
    return emptyUtm();
  }
}

function queryParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (!value || !value.trim()) return null;
  return value.trim();
}

function readRefundTransactions(value: unknown): number | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  let total = 0;
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const transaction = item as Record<string, unknown>;
    const kind = typeof transaction.kind === 'string' ? transaction.kind : 'refund';
    const status = typeof transaction.status === 'string' ? transaction.status : 'success';
    if (kind !== 'refund' || status !== 'success') continue;
    total += parseMoneyToCents(transaction.amount, 'transactions.amount');
  }

  if (total <= 0) {
    throw new IngestError(422, 'invalid_refund', 'Nenhuma transação de estorno bem-sucedida.');
  }
  return total;
}

function readCurrency(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
    throw new IngestError(400, 'invalid_payload', 'Campo currency deve ter três letras.');
  }
  return value.trim().toUpperCase();
}

function readId(value: unknown, field: string): string {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new IngestError(400, 'invalid_payload', `Campo ${field} inválido.`);
}

function asRecord(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new IngestError(400, 'invalid_payload', 'O corpo do webhook precisa ser um objeto JSON.');
  }
  return body as Record<string, unknown>;
}

function emptyUtm(): UtmParams {
  return { source: null, medium: null, campaign: null, content: null };
}
