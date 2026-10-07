import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LedgerEntry, OrderSummary } from '../src/domain/types.js';
import { DEV_WEBHOOK_SECRET, signShopifyHmac } from '../src/shopify/hmac.js';

type WebhookResult = {
  duplicate: boolean;
  reason?: string;
  orderId: string;
  summary: OrderSummary;
};

describe('webhook de pedidos', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp().app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('não soma a venda quando o mesmo pedido chega de novo', async () => {
    const first = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-pedido-1',
      body: paidOrder({ id: 1001, total: '150.00', coupon: 'ANA10' }),
    });
    expect(first.statusCode).toBe(200);
    const created = first.json<WebhookResult>();
    expect(created.duplicate).toBe(false);
    expect(created.summary.creditedCents).toBe(15000);
    expect(created.summary.entries).toHaveLength(1);

    const sameDelivery = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-pedido-1',
      body: paidOrder({ id: 1001, total: '150.00', coupon: 'ANA10' }),
    });
    expect(sameDelivery.json<WebhookResult>()).toMatchObject({
      duplicate: true,
      reason: 'event_already_processed',
      summary: { grossCents: 15000, creditedCents: 15000 },
    });

    const sameOrder = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-pedido-1-repetido',
      body: paidOrder({ id: 1001, total: '150.00', coupon: 'ANA10' }),
    });
    expect(sameOrder.json<WebhookResult>()).toMatchObject({
      duplicate: true,
      reason: 'order_already_ingested',
      summary: { grossCents: 15000, creditedCents: 15000 },
    });

    const stored = await getOrder(app, '1001');
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.kind).toBe('sale');
    expect(stored.grossCents).toBe(15000);
  });

  it('estorno parcial reduz o crédito e o total zera sem apagar a venda', async () => {
    await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-venda',
      body: paidOrder({ id: 2002, total: '100.00', coupon: 'BRUNO15' }),
    });
    const before = await getOrder(app, '2002');
    const sale = before.entries[0] as LedgerEntry;

    const partial = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-estorno-parcial',
      body: refund({ id: 501, orderId: 2002, amount: '40.00' }),
    });
    expect(partial.statusCode).toBe(200);
    const afterPartial = partial.json<WebhookResult>().summary;
    expect(afterPartial.creditedCents).toBe(6000);
    expect(afterPartial.reversed).toBe(false);
    expect(afterPartial.entries).toHaveLength(2);
    expect(afterPartial.entries[0]).toEqual(sale);
    expect(afterPartial.attribution).toEqual(before.attribution);
    expect(afterPartial.entries[1]).toMatchObject({
      kind: 'refund',
      amountCents: 4000,
      creatorId: 'bruno',
      refundId: '501',
    });

    const rest = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-estorno-restante',
      body: refund({ id: 502, orderId: 2002, amount: '60.00' }),
    });
    const afterFull = rest.json<WebhookResult>().summary;
    expect(afterFull.creditedCents).toBe(0);
    expect(afterFull.netCents).toBe(0);
    expect(afterFull.refundedCents).toBe(10000);
    expect(afterFull.reversed).toBe(true);
    expect(afterFull.entries.map((entry) => entry.kind)).toEqual(['sale', 'refund', 'refund']);
    expect(afterFull.entries[0]).toEqual(sale);
    expect(afterFull.attribution.creatorId).toBe('bruno');

    const replay = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-estorno-parcial',
      body: refund({ id: 501, orderId: 2002, amount: '40.00' }),
    });
    expect(replay.json<WebhookResult>()).toMatchObject({
      duplicate: true,
      reason: 'event_already_processed',
      summary: { refundedCents: 10000, creditedCents: 0 },
    });

    const sameRefundNewDelivery = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-estorno-parcial-de-novo',
      body: refund({ id: 501, orderId: 2002, amount: '40.00' }),
    });
    expect(sameRefundNewDelivery.json<WebhookResult>().duplicate).toBe(true);
    expect(sameRefundNewDelivery.json<WebhookResult>().summary.entries).toHaveLength(3);
  });

  it('cupom vence a UTM no webhook quando apontam para criadores diferentes', async () => {
    const response = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-desempate',
      body: {
        id: 3003,
        total_price: '80.00',
        currency: 'BRL',
        financial_status: 'paid',
        discount_codes: [{ code: 'ANA10', amount: '8.00', type: 'percentage' }],
        landing_site:
          'https://loja.example/produtos/kit?utm_source=instagram&utm_medium=influencer&utm_campaign=lancamento&utm_content=bruno',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<WebhookResult>().summary).toMatchObject({
      couponCode: 'ANA10',
      creditedCents: 8000,
      attribution: {
        rule: 'coupon_over_utm',
        creatorId: 'ana',
        source: 'coupon',
        couponWonTie: true,
        couponCreatorId: 'ana',
        utmCreatorId: 'bruno',
      },
    });

    const ana = await app.inject({ method: 'GET', url: '/creators/ana/sales' });
    expect(ana.json()).toMatchObject({
      creatorId: 'ana',
      creditedCents: 8000,
      orders: [{ orderId: '3003', couponWonTie: true, reversed: false }],
    });

    const bruno = await app.inject({ method: 'GET', url: '/creators/bruno/sales' });
    expect(bruno.json()).toMatchObject({ creatorId: 'bruno', creditedCents: 0, orders: [] });
  });

  it('soma só o saldo ainda creditado ao criador, inclusive venda zerada por estorno', async () => {
    await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-ana-1',
      body: paidOrder({ id: 4001, total: '50.00', utmContent: 'ana' }),
    });
    await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-ana-2',
      body: paidOrder({ id: 4002, total: '20.00', coupon: 'ANA10' }),
    });
    await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-ana-2-estorno',
      body: refund({ id: 900, orderId: 4002, amount: '20.00' }),
    });

    const ana = await app.inject({ method: 'GET', url: '/creators/ana/sales' });
    expect(ana.json()).toMatchObject({
      creditedCents: 5000,
      orders: [
        { orderId: '4001', source: 'utm', creditedCents: 5000, reversed: false },
        { orderId: '4002', source: 'coupon', creditedCents: 0, reversed: true },
      ],
    });
  });

  it('grava venda sem criador e estorno maior que o saldo sem apagar o histórico', async () => {
    const created = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-sem-criador',
      body: paidOrder({ id: 8008, total: '25.00', coupon: 'DESCONHECIDO' }),
    });
    const sale = created.json<WebhookResult>().summary;
    expect(sale).toMatchObject({
      creditedCents: 0,
      grossCents: 2500,
      attribution: { creatorId: null, source: 'none', couponWonTie: false },
    });

    await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-excede',
      body: paidOrder({ id: 8009, total: '25.00', coupon: 'ANA10' }),
    });
    const before = await getOrder(app, '8009');
    const over = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-excede-estorno',
      body: refund({ id: 880, orderId: 8009, amount: '40.00' }),
    });
    const summary = over.json<WebhookResult>().summary;
    expect(summary.refundedCents).toBe(4000);
    expect(summary.netCents).toBe(0);
    expect(summary.creditedCents).toBe(0);
    expect(summary.reversed).toBe(true);
    expect(summary.entries[0]).toEqual(before.entries[0]);
    expect(summary.entries).toHaveLength(2);
  });

  it('recusa assinatura inválida e não grava o pedido', async () => {
    const response = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-falso',
      body: paidOrder({ id: 5005, total: '10.00', coupon: 'ANA10' }),
      hmac: 'assinatura-invalida',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: 'invalid_hmac' });

    const stored = await app.inject({ method: 'GET', url: '/orders/5005' });
    expect(stored.statusCode).toBe(404);
  });

  it('ignora pedido que ainda não foi pago e aceita a entrega paga depois', async () => {
    const pending = await postWebhook(app, {
      topic: 'orders/create',
      eventId: 'evt-pendente',
      body: {
        id: 6006,
        total_price: '30.00',
        currency: 'BRL',
        financial_status: 'pending',
        coupon: 'ANA10',
      },
    });
    expect(pending.json()).toMatchObject({ ignored: true, reason: 'status_not_payable' });
    expect((await app.inject({ method: 'GET', url: '/orders/6006' })).statusCode).toBe(404);

    const paid = await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-pago',
      body: paidOrder({ id: 6006, total: '30.00', coupon: 'ANA10' }),
    });
    expect(paid.json<WebhookResult>().summary.creditedCents).toBe(3000);
    expect(paid.json<WebhookResult>().summary.entries).toHaveLength(1);
  });

  it('não estorna pedido desconhecido nem aceita moeda diferente', async () => {
    const missing = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-sem-pedido',
      body: refund({ id: 1, orderId: 404, amount: '10.00' }),
    });
    expect(missing.statusCode).toBe(404);

    await postWebhook(app, {
      topic: 'orders/paid',
      eventId: 'evt-moeda',
      body: paidOrder({ id: 7007, total: '10.00', coupon: 'ANA10' }),
    });
    const mismatch = await postWebhook(app, {
      topic: 'refunds/create',
      eventId: 'evt-moeda-estorno',
      body: { ...refund({ id: 2, orderId: 7007, amount: '10.00' }), currency: 'USD' },
    });
    expect(mismatch.statusCode).toBe(422);
    expect((await getOrder(app, '7007')).entries).toHaveLength(1);
  });
});

function paidOrder(input: { id: number; total: string; coupon?: string; utmContent?: string }) {
  return {
    id: input.id,
    total_price: input.total,
    currency: 'BRL',
    financial_status: 'paid',
    ...(input.coupon ? { discount_codes: [{ code: input.coupon, amount: '0.00', type: 'fixed_amount' }] } : {}),
    ...(input.utmContent
      ? { landing_site: `https://loja.example/p?utm_source=instagram&utm_content=${input.utmContent}` }
      : {}),
  };
}

function refund(input: { id: number; orderId: number; amount: string }) {
  return {
    id: input.id,
    order_id: input.orderId,
    transactions: [{ amount: input.amount, kind: 'refund', status: 'success' }],
  };
}

async function getOrder(app: FastifyInstance, orderId: string): Promise<OrderSummary> {
  const response = await app.inject({ method: 'GET', url: `/orders/${orderId}` });
  expect(response.statusCode).toBe(200);
  return response.json<OrderSummary>();
}

async function postWebhook(
  app: FastifyInstance,
  input: {
    topic: string;
    eventId: string;
    body: unknown;
    hmac?: string | null;
  },
) {
  const payload = JSON.stringify(input.body);
  const signature =
    input.hmac === undefined ? signShopifyHmac(payload, DEV_WEBHOOK_SECRET) : input.hmac;

  return app.inject({
    method: 'POST',
    url: '/webhooks/shopify',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': input.topic,
      'x-shopify-webhook-id': input.eventId,
      ...(signature ? { 'x-shopify-hmac-sha256': signature } : {}),
    },
    payload,
  });
}
