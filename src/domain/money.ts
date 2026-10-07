import { IngestError } from '../errors.js';

/**
 * Converte um valor monetário ("199.90" ou "199,90") em centavos.
 * Não aceita separador de milhar nem mais de duas casas decimais.
 */
export function parseMoneyToCents(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw invalid(field);
    }
    value = value.toFixed(2);
  }

  if (typeof value !== 'string') {
    throw invalid(field);
  }

  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    throw invalid(field);
  }

  const [whole, fraction = ''] = normalized.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

function invalid(field: string): IngestError {
  return new IngestError(
    400,
    'invalid_payload',
    `Campo ${field} deve ser um valor monetário com até duas casas decimais.`,
  );
}
