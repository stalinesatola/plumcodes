---
name: add-strategy
description: >
  Adicionar uma nova estratégia de trading ao bot Deriv (Downloads/plumcodes) do jeito
  certo. Use SEMPRE que o usuário pedir para "criar uma estratégia", "adicionar um
  setup", "implementar" um método de trading (ICT/SMC, order block, FVG, breakout,
  VWAP, RSI, suporte/resistência, price action, etc.), "colocar mais um bot", ou
  descrever regras de entrada/saída que quer automatizar. Cobre a interface Strategy,
  os três kinds (digits/riseFall/candle), o wiring de features e config, e o passo
  obrigatório de backtest/forward-test antes de ligar em conta real.
---

# Adicionar uma estratégia

## Arquitetura em 30 segundos

- `src/strategies/index.ts` — todas as estratégias, num `REGISTRY` por nome.
- Uma `Strategy` tem `name`, `warmup`, `kind` e `evaluate(ctx) -> TradeIntent | null`.
- O `Bot` (`src/bot.ts`) chama `evaluate` a cada tick, aplica 3 gates (bandit → ML →
  risco) e executa. O aprendizado (bandit + modelo online) agrupa resultados pelo
  campo `tag` do `TradeIntent` — escolha tags estáveis e descritivas.
- `config.json` liga a estratégia a um símbolo, stake e limites, via `"strategy": "<name>"`.

## Passo 1 — Escolher o kind

| kind | dados no `ctx` | contrato | quando usar |
|---|---|---|---|
| `digits` | `ctx.digits` (últimos dígitos), `ctx.prices` | DIGIT* (1 tick) | padrões de último dígito. Aviso: RNG uniforme, sem edge real, foca winrate |
| `riseFall` | `ctx.prices` (série de ticks) | CALL/PUT por N ticks | momentum/MA/RSI de curtíssimo prazo, resultado binário |
| `candle` | `ctx.candles` (M1 OHLC), `ctx.candleClosed` | **MULTUP/MULTDOWN** com SL/TP em USD | setups de gráfico com stop e alvo (mBOS, EMA, VWAP, order block, breakout) |

A maioria dos setups "de trader" (ICT, price action, S/R, breakout com stop) é
`kind: "candle"` — só eles conseguem stop no swing e RR fixo.

## Passo 2 — Escrever o `evaluate`

```ts
const meuSetup: Strategy = {
  name: "ob_retest",              // kebab/snake, único
  warmup: 0,                       // p/ candle deixe 0; a checagem de tamanho é interna
  kind: "candle",
  evaluate(ctx): TradeIntent | null {
    if (!ctx.candleClosed) return null;         // candle: só age no fechamento
    const c = ctx.candles;
    const need = (ctx.params.emaPeriod ?? 50) + 40;
    if (c.length < need) return null;

    const closes = c.map(x => x.close);
    // ... indicadores de src/util/indicators.ts: ema, sma, rsi, stochastic,
    //     lastFractalSwings, momentum ...

    // LONG:
    return {
      contractType: "MULTUP",
      durationTicks: 0,
      tag: "MULTUP",                             // ou algo mais específico e ESTÁVEL
      multiplier: ctx.params.multiplier ?? 100,
      stopDistance: closes.at(-1)! - stopPrice,  // distância de preço até o stop
      rr: ctx.params.rr ?? 2,
    };
  },
};
```

Regras:
- **Todo parâmetro vem de `ctx.params`** com um default no código. Nunca hard-code
  números que o usuário possa querer ajustar — eles têm de aparecer no `config.json`.
- **`ctx.tuning`** (-1..+1) é o ajuste que o hill-climb aprende. Use para deslocar um
  limiar (ver `rsi_reversion`, `digits_under`). Opcional mas recomendado.
- Não faça I/O, não guarde estado no módulo. `evaluate` é uma função pura de `ctx`.
- Registre a estratégia no array do `REGISTRY` no fim do arquivo.

## Passo 3 — Features para o ML (se o setup tiver sinais próprios)

`src/util/features.ts` monta o vetor de 29 features que o modelo online recebe. Se a
sua estratégia usa um indicador que ainda não está lá e que ajuda a prever o
resultado, adicione — mas **mantenha a dimensão fixa** (o modelo Python assume tamanho
constante por `key`). Se adicionar, some 1 à contagem no comentário e considere apagar
`ml/model.json` para re-treinar.

## Passo 4 — Entrada no `config.json`

```jsonc
{
  "id": "v75-ob-retest",
  "enabled": false,                 // COMECE DESLIGADO
  "strategy": "ob_retest",
  "symbol": "R_75",
  "durationTicks": 0,               // 0 p/ candle/MULT; 1 p/ digits; 3-10 p/ riseFall
  "stake": { "base": 1, "martingale": { "enabled": false, "factor": 2, "maxSteps": 2 } },
  "params": { "emaPeriod": 50, "multiplier": 100, "rr": 2, "...": 0 },
  "riskPerTradePct": 1,             // MULT: dimensiona o stake pela perda no swing
  "daily": { "maxWins": 3, "maxLosses": 2, "maxTrades": 8 },
  "maxHoldMinutes": 30,
  "botStopLossUsd": 15,
  "botTakeProfitUsd": 25
}
```

Se somar um bot ativo, confira `risk.maxConcurrentBots`.

## Passo 5 — Validar ANTES de ligar

1. `npx tsc --noEmit` — sem erro.
2. Teste unitário rápido: um script que importa `getStrategy("...")` e alimenta
   candles/preços sintéticos de um setup claro (long, short) e de mercado lateral
   (deve dar `null`). Confirme que dispara quando deve e fica quieto quando não deve.
3. **Backtest** (só `kind: "candle"`): skill `backtest-strategy`.
   `node --env-file=.env tools/backtest.ts <name> R_75 --candles 8000`.
   Expectancy tem de ser > 0. Amostra < 50 não vale.
4. Ligue em **demo** (`"enabled": true`, `account.mode` continua `"demo"`).
5. Só depois de dias em demo com expectancy positiva real: considere conta real, com
   `learning.exploreTrades: 0` e stakes revistos.

## Menu de setups comuns (todos `kind: "candle"`)

| setup | ideia | indicadores já disponíveis |
|---|---|---|
| EMA bounce | pullback à EMA na direção da tendência | `ema` |
| mBOS + estocástico | já implementado como `m1_scalp` | `stochastic`, `lastFractalSwings` |
| Order block / FVG retest | reentra na zona deixada por candle de impulso | `lastFractalSwings` + lógica de zona |
| Breakout de range | rompe máxima/mínima de N candles com stop no meio | `sma`, high/low de janela |
| VWAP revert | distância à VWAP da sessão | somar VWAP em `indicators.ts` |
| RSI div | divergência preço × RSI em M1 | `rsi` |

Regras de ouro (valem para qualquer um): risco ≤ 1%/trade (`riskPerTradePct`),
limites diários (`daily`), RR ≥ 1.5, e **expectancy > 0 no backtest + demo** antes de
qualquer dólar real.
