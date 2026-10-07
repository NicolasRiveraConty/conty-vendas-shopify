import { createHmac, timingSafeEqual } from 'node:crypto';

/** Segredo fictício. Não é credencial de uma loja real. */
export const DEV_WEBHOOK_SECRET = 'cont-y-dev-secret';

export function signShopifyHmac(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

/** Confere o header X-Shopify-Hmac-Sha256 sobre o corpo cru, como a Shopify. */
export function verifyShopifyHmac(rawBody: string, header: string | undefined, secret: string): boolean {
  if (!header) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const received = Buffer.from(header, 'base64');
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
