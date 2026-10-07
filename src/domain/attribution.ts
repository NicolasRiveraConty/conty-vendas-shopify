import type { AttributionDecision, Creator } from './types.js';

export type AttributionInput = {
  couponCode: string | null;
  utmContent: string | null;
};

/**
 * Atribui a venda a no máximo um criador.
 *
 * Desempate: o cupom vence a UTM (`coupon_over_utm`).
 * O cupom é um código que a marca entregou ao criador e o comprador
 * aplicou no checkout. A UTM nasce no link: pode ser copiada, expirar
 * ou apontar para outra pessoa sem o checkout confirmar. Quando os dois
 * sinais identificam criadores diferentes, fica o do cupom. A UTM só
 * atribui quando não há cupom de um criador conhecido. Sem sinal
 * conhecido, a venda fica sem criador.
 *
 * Esta é a única função que escolhe o criador. Estorno não passa por aqui.
 */
export function attributeSale(
  input: AttributionInput,
  creators: readonly Creator[],
): AttributionDecision {
  const coupon = normalizeSignal(input.couponCode);
  const utm = normalizeSignal(input.utmContent);

  const couponCreator = coupon
    ? creators.find((creator) => creator.coupons.some((code) => normalizeSignal(code) === coupon)) ?? null
    : null;
  const utmCreator = utm
    ? creators.find((creator) => normalizeSignal(creator.utmContent) === utm) ?? null
    : null;

  const base = {
    rule: 'coupon_over_utm' as const,
    couponCreatorId: couponCreator?.id ?? null,
    utmCreatorId: utmCreator?.id ?? null,
  };

  if (couponCreator && utmCreator && couponCreator.id !== utmCreator.id) {
    return {
      ...base,
      creatorId: couponCreator.id,
      source: 'coupon',
      couponWonTie: true,
    };
  }

  if (couponCreator) {
    return {
      ...base,
      creatorId: couponCreator.id,
      source: 'coupon',
      couponWonTie: false,
    };
  }

  if (utmCreator) {
    return {
      ...base,
      creatorId: utmCreator.id,
      source: 'utm',
      couponWonTie: false,
    };
  }

  return {
    ...base,
    creatorId: null,
    source: 'none',
    couponWonTie: false,
  };
}

/** Comparação de cupom e utm_content: sem caixa e sem espaço nas pontas. */
export function normalizeSignal(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
}
