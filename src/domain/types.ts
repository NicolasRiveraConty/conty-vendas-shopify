export type AttributionSource = 'coupon' | 'utm' | 'none';

export type UtmParams = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
};

export type Creator = {
  id: string;
  name: string;
  /** Códigos de cupom. A comparação é case-insensitive. */
  coupons: string[];
  /** Valor de utm_content que identifica o criador. */
  utmContent: string;
};

/**
 * Decisão congelada no momento da venda. Estorno não recalcula isso.
 * `rule` deixa explícito qual desempate produziu o resultado.
 */
export type AttributionDecision = {
  rule: 'coupon_over_utm';
  creatorId: string | null;
  source: AttributionSource;
  /** Verdadeiro só quando cupom e UTM apontavam para criadores diferentes. */
  couponWonTie: boolean;
  couponCreatorId: string | null;
  utmCreatorId: string | null;
};

export type LedgerKind = 'sale' | 'refund';

export type LedgerEntry = {
  id: string;
  eventId: string;
  orderId: string;
  kind: LedgerKind;
  /** Sempre positivo. A venda soma; o estorno subtrai no saldo. */
  amountCents: number;
  currency: string;
  refundId: string | null;
  creatorId: string | null;
  source: AttributionSource | null;
  recordedAt: string;
};

export type OrderSnapshot = {
  orderId: string;
  currency: string;
  status: string;
  couponCode: string | null;
  utm: UtmParams;
  attribution: AttributionDecision;
  recordedAt: string;
};

export type OrderSummary = {
  orderId: string;
  currency: string;
  status: string;
  couponCode: string | null;
  utm: UtmParams;
  attribution: AttributionDecision;
  grossCents: number;
  refundedCents: number;
  /** Saldo da venda depois dos estornos. Nunca negativo. */
  netCents: number;
  /** Valor ainda creditado ao criador. Zero sem criador ou com estorno total. */
  creditedCents: number;
  /** A venda teve criador e o saldo creditado chegou a zero. */
  reversed: boolean;
  entries: LedgerEntry[];
};
