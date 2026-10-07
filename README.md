# Atribuição de vendas a criadores

Webhook de pedido de loja (no formato essencial de um pedido Shopify) que credita a venda a **no máximo um criador**. Entrega repetida não soma de novo. Estorno parcial ou total entra num ledger append-only: o saldo creditado cai, o histórico fica.

Não há loja Shopify de verdade. O segredo HMAC abaixo é fictício.

## Por onde começar

1. [`src/domain/attribution.ts`](src/domain/attribution.ts) — a única função que escolhe o criador, com o desempate.
2. [`src/sales/ingest.ts`](src/sales/ingest.ts) — idempotência da venda e estorno que só acrescenta lançamento.
3. [`test/attribution.test.ts`](test/attribution.test.ts) e [`test/http.test.ts`](test/http.test.ts) — desempate, pedido duplicado e estorno.

## Como rodar

Requer Node 20+.

```bash
npm install
npm test
npm run dev
```

O servidor sobe em `http://localhost:3000`. Outra porta: `PORT=3001 npm run dev`.

Criadores de exemplo, já carregados na memória:

| Criador | Cupom    | `utm_content` |
| ------- | -------- | ------------- |
| `ana`   | `ANA10`  | `ana`         |
| `bruno` | `BRUNO15`| `bruno`       |

Rotas:

- `POST /webhooks/shopify`
- `GET /orders/:orderId` — atribuição congelada, saldo e ledger
- `GET /creators/:creatorId/sales` — o que ainda está creditado àquele criador

## Exemplos de payload

Headers de toda entrega:

- `Content-Type: application/json`
- `X-Shopify-Topic`: `orders/paid`, `orders/create` ou `refunds/create`
- `X-Shopify-Webhook-Id`: id único da entrega (idempotência)
- `X-Shopify-Hmac-Sha256`: HMAC-SHA256 do corpo cru, em base64, com o segredo `cont-y-dev-secret` (ou `SHOPIFY_WEBHOOK_SECRET`)

Venda paga. O cupom é da Ana e a UTM é do Bruno; o desempate fica com a Ana.

```bash
BODY='{"id":1001,"total_price":"199.90","currency":"BRL","financial_status":"paid","discount_codes":[{"code":"ANA10","amount":"10.00","type":"percentage"}],"landing_site":"https://loja.example/produtos/kit?utm_source=instagram&utm_medium=influencer&utm_campaign=lancamento&utm_content=bruno"}'
SIG=$(node -e "const {createHmac}=require('crypto'); process.stdout.write(createHmac('sha256','cont-y-dev-secret').update(process.argv[1]).digest('base64'))" "$BODY")

curl -s -X POST http://localhost:3000/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: orders/paid" \
  -H "X-Shopify-Webhook-Id: evt-1001" \
  -H "X-Shopify-Hmac-Sha256: $SIG" \
  -d "$BODY"
```

Estorno parcial, dias depois. `id` é o id do estorno; `order_id` é o pedido.

```bash
BODY='{"id":501,"order_id":1001,"transactions":[{"amount":"50.00","kind":"refund","status":"success"}]}'
SIG=$(node -e "const {createHmac}=require('crypto'); process.stdout.write(createHmac('sha256','cont-y-dev-secret').update(process.argv[1]).digest('base64'))" "$BODY")

curl -s -X POST http://localhost:3000/webhooks/shopify \
  -H "Content-Type: application/json" \
  -H "X-Shopify-Topic: refunds/create" \
  -H "X-Shopify-Webhook-Id: evt-501" \
  -H "X-Shopify-Hmac-Sha256: $SIG" \
  -d "$BODY"
```

Atalhos aceitos no JSON, além dos campos no estilo Shopify: `total` no lugar de `total_price`, `coupon` no lugar de `discount_codes`, `status` no lugar de `financial_status`, e `utm: { "content": "ana" }` no lugar da query em `landing_site`. No estorno, `amount` substitui `transactions` quando a lista não vem.

`orders/create` com `financial_status` `pending` responde 200 e não credita. Status que geram venda: `paid`, `partially_paid`, `partially_refunded`. O valor creditado é o `total_price` (o total do pedido, em centavos). Ids grandes demais para o inteiro seguro do JSON (o caso comum na Shopify) devem ir como string.

Consulta:

```bash
curl -s http://localhost:3000/orders/1001
curl -s http://localhost:3000/creators/ana/sales
```

## Regra de desempate

Função pura `attributeSale` em `src/domain/attribution.ts`. Regra: **cupom vence UTM** (`coupon_over_utm`).

O cupom é um código que a marca entregou ao criador e o comprador aplicou no checkout. A UTM nasce no link e pode ser copiada, ficar velha ou apontar para outra pessoa sem o checkout confirmar. Se os dois identificam criadores diferentes, a venda fica com o cupom (`couponWonTie: true`). Se apontam para o mesmo criador, a fonte registrada é o cupom e não há desempate. A UTM só atribui quando não existe cupom de um criador conhecido. Sem sinal conhecido, `creatorId` fica `null`: a venda existe, ninguém é creditado.

Cupom e `utm_content` são comparados sem diferença de maiúsculas. O criador da UTM é o `utm_content`. Cupom e `utm_content` não se repetem entre criadores; se o cadastro colidir, o processo recusa subir.

O estorno **não** chama essa função de novo. A decisão fica gravada no pedido.

## Rastreio do estorno

Cada venda e cada estorno é uma linha no ledger (`entries`). Não há update nem delete.

- Venda repetida (mesmo `X-Shopify-Webhook-Id`, ou o mesmo id de pedido em outra entrega) responde `duplicate: true` e não cria outra linha de venda.
- Estorno repetido (mesmo webhook ou mesmo id de estorno) também não lança de novo.
- Estorno parcial soma em `refundedCents` e reduz `creditedCents`.
- Estorno que cobre o saldo deixa `creditedCents` e `netCents` em 0 e `reversed: true`. A linha `sale` continua lá, com o mesmo criador.
- Estorno maior que o saldo não reescreve as linhas anteriores. `refundedCents` mostra a soma pedida; o crédito para em zero.
- `GET /creators/:id/sales` continua listando a venda zerada, para a marca ver que houve atribuição e que ela foi revertida.

Os dados estão na memória do processo. Reiniciar apaga o ledger.

## O que ficou de fora

- Conexão real com a API da Shopify (sem OAuth, app instalado ou polling).
- Persistência durável. A interface `SalesRepository` isola a memória; SQLite entraria ali.
- Fila para estorno que chega antes do pedido: hoje responde 404.
- Dividir uma venda entre vários criadores, ou atribuir por item.
- Conversão de moeda. Estorno em outra moeda é recusado.
- Painel. A leitura é a API.

## Uso de IA

O código deste repositório foi gerado por um agente de IA (Cursor).

Revisado por Nicolas: [preencher]
