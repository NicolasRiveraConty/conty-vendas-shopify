import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { seedCreators } from './creators.js';
import type { Creator } from './domain/types.js';
import { IngestError } from './errors.js';
import { MemorySalesRepository, type SalesRepository } from './ledger/repository.js';
import { summarizeCreator, summarizeOrder } from './ledger/summary.js';
import { ingestRefund, ingestSale } from './sales/ingest.js';
import { DEV_WEBHOOK_SECRET, verifyShopifyHmac } from './shopify/hmac.js';
import { parseRefundBody, parseSaleBody } from './shopify/parse.js';

export type BuildAppOptions = {
  secret?: string;
  creators?: readonly Creator[];
  logger?: boolean;
  repository?: SalesRepository;
};

export type AppContext = {
  app: FastifyInstance;
  repository: SalesRepository;
};

const SALE_TOPICS = new Set(['orders/paid', 'orders/create']);

export function buildApp(options: BuildAppOptions = {}): AppContext {
  const repository = options.repository ?? new MemorySalesRepository(options.creators ?? seedCreators);
  const secret = options.secret ?? process.env.SHOPIFY_WEBHOOK_SECRET ?? DEV_WEBHOOK_SECRET;

  const app = Fastify({ logger: options.logger ?? false });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof IngestError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
        ? error.statusCode
        : 500;
    const message = error instanceof Error ? error.message : 'Erro interno.';
    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'internal_error' : 'bad_request',
      message: statusCode >= 500 ? 'Erro interno.' : message,
    });
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const raw = typeof body === 'string' ? body : body.toString('utf8');
    request.rawBody = raw;
    if (!raw.trim()) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(raw) as unknown);
    } catch {
      const error = new IngestError(400, 'invalid_json', 'JSON inválido.');
      done(error, undefined);
    }
  });

  app.get('/', async () => ({
    service: 'conty-vendas',
    webhook: 'POST /webhooks/shopify',
    order: 'GET /orders/:orderId',
    creator: 'GET /creators/:creatorId/sales',
  }));

  app.get('/health', async () => ({ ok: true }));

  app.post('/webhooks/shopify', async (request, reply) => {
    try {
      const rawBody = request.rawBody ?? '';
      const provided = header(request, 'x-shopify-hmac-sha256');
      if (!verifyShopifyHmac(rawBody, provided, secret)) {
        return reply.code(401).send({
          error: 'invalid_hmac',
          message: 'Assinatura HMAC inválida.',
        });
      }

      const topic = header(request, 'x-shopify-topic')?.toLowerCase();
      const eventId = header(request, 'x-shopify-webhook-id')?.trim();
      if (!topic || !eventId) {
        throw new IngestError(
          400,
          'invalid_headers',
          'Headers X-Shopify-Topic e X-Shopify-Webhook-Id são obrigatórios.',
        );
      }

      if (SALE_TOPICS.has(topic)) {
        const sale = parseSaleBody(topic, request.body);
        if (!sale.payable) {
          return reply.code(200).send({
            ignored: true,
            reason: 'status_not_payable',
            orderId: sale.orderId,
            status: sale.status,
          });
        }
        const result = ingestSale(repository, {
          eventId,
          orderId: sale.orderId,
          totalCents: sale.totalCents,
          currency: sale.currency,
          status: sale.status,
          couponCode: sale.couponCode,
          utm: sale.utm,
        });
        return reply.code(200).send(result);
      }

      if (topic === 'refunds/create') {
        const refund = parseRefundBody(request.body);
        const result = ingestRefund(repository, { eventId, ...refund });
        return reply.code(200).send(result);
      }

      throw new IngestError(400, 'unsupported_topic', `Tópico não suportado: ${topic}.`);
    } catch (error) {
      if (error instanceof IngestError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get('/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params as { orderId: string };
    const order = repository.getOrder(orderId);
    if (!order) {
      return reply.code(404).send({ error: 'order_not_found', message: 'Pedido não encontrado.' });
    }
    return summarizeOrder(order, repository.listEntries(orderId));
  });

  app.get('/creators/:creatorId/sales', async (request, reply) => {
    const { creatorId } = request.params as { creatorId: string };
    const known = repository.listCreators().some((creator) => creator.id === creatorId);
    if (!known) {
      return reply.code(404).send({ error: 'creator_not_found', message: 'Criador não encontrado.' });
    }
    return summarizeCreator(creatorId, repository.listOrders(), (orderId) => repository.listEntries(orderId));
  });

  return { app, repository };
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}
