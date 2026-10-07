import { describe, expect, it } from 'vitest';
import { attributeSale } from '../src/domain/attribution.js';
import type { Creator } from '../src/domain/types.js';

const creators: Creator[] = [
  { id: 'ana', name: 'Ana Lima', coupons: ['ANA10'], utmContent: 'ana' },
  { id: 'bruno', name: 'Bruno Dias', coupons: ['BRUNO15'], utmContent: 'bruno' },
];

describe('attributeSale', () => {
  it('atribui pelo cupom quando não há UTM', () => {
    const decision = attributeSale({ couponCode: 'ana10', utmContent: null }, creators);

    expect(decision).toEqual({
      rule: 'coupon_over_utm',
      creatorId: 'ana',
      source: 'coupon',
      couponWonTie: false,
      couponCreatorId: 'ana',
      utmCreatorId: null,
    });
  });

  it('atribui pela UTM quando o cupom não identifica criador', () => {
    const decision = attributeSale({ couponCode: 'BEMVINDO', utmContent: 'Bruno' }, creators);

    expect(decision.creatorId).toBe('bruno');
    expect(decision.source).toBe('utm');
    expect(decision.couponWonTie).toBe(false);
  });

  it('não marca desempate quando cupom e UTM são o mesmo criador', () => {
    const decision = attributeSale({ couponCode: 'ANA10', utmContent: 'ana' }, creators);

    expect(decision.creatorId).toBe('ana');
    expect(decision.source).toBe('coupon');
    expect(decision.couponWonTie).toBe(false);
    expect(decision.couponCreatorId).toBe('ana');
    expect(decision.utmCreatorId).toBe('ana');
  });

  it('dá o desempate ao cupom quando os sinais apontam para criadores diferentes', () => {
    const decision = attributeSale({ couponCode: ' ANA10 ', utmContent: 'bruno' }, creators);

    expect(decision).toMatchObject({
      rule: 'coupon_over_utm',
      creatorId: 'ana',
      source: 'coupon',
      couponWonTie: true,
      couponCreatorId: 'ana',
      utmCreatorId: 'bruno',
    });
  });

  it('deixa a venda sem criador quando nenhum sinal é conhecido', () => {
    const decision = attributeSale({ couponCode: null, utmContent: '  ' }, creators);

    expect(decision.creatorId).toBeNull();
    expect(decision.source).toBe('none');
    expect(decision.couponWonTie).toBe(false);
  });

  it('não altera a lista de criadores', () => {
    const snapshot = structuredClone(creators);
    attributeSale({ couponCode: 'ANA10', utmContent: 'bruno' }, creators);
    expect(creators).toEqual(snapshot);
  });
});
