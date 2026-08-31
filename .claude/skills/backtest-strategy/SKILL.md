---
name: backtest-strategy
description: >
  Backtest offline de estratégias do bot Deriv (Downloads/plumcodes) antes de ligar em
  conta real. Use SEMPRE que o usuário quiser "testar uma estratégia", "backtestar",
  "ver se funciona antes de arriscar", "validar parâmetros", comparar variantes de
  m1_scalp / EMA / estocástico, ou antes de mudar account.mode para "real". Roda
  tools/backtest.ts, que baixa candles históricos da Deriv e simula a estratégia,
  reportando expectancy (R), winrate, drawdown e pior sequência de losses. Só cobre
  estratégias kind:"candle" (m1_scalp) — as de dígito não são backtestáveis.
---

# Backtest de estratégia

## Quando serve e quando não serve

**Serve** para estratégias baseadas em candle (`m1_scalp` e futuras `kind: "candle"`):
comparar variantes de parâmetro e descartar as claramente ruins antes de gastar
dinheiro. O simulador caminha pelos candles seguintes e vê se o take-profit
(`rr * stopDistance`) é atingido antes do stop.

**NÃO serve** para estratégias de dígito (`digits_*`). O resultado de um contrato de
dígito depende do dígito exato liquidado e do RNG — não dá para reconstruir do
histórico de preço. Essas só se validam em **forward-test na conta demo**.

**Limitações** (dizer ao usuário sempre): não modela o preço tick-a-tick dentro do
candle, nem spread/comissão com precisão. Se stop e alvo caem no mesmo candle, conta
como perda (conservador). É um filtro grosseiro, não uma prova.

## Como rodar

```
node --env-file=.env tools/backtest.ts <strategy> <symbol> [--candles N] [--granularity S] [--param k=v ...]
```

Exemplos:

```
# baseline atual do m1_scalp em V75
node --env-file=.env tools/backtest.ts m1_scalp R_75 --candles 8000 --param multiplier=100 --param rr=2

# variante: stop mais largo (swingK 3) e alvo 1:1.5
node --env-file=.env tools/backtest.ts m1_scalp R_75 --candles 8000 --param swingK=3 --param rr=1.5

# outro símbolo
node --env-file=.env tools/backtest.ts m1_scalp R_10 --candles 8000 --param multiplier=300
```

`--candles` pagina de mil em mil para trás (máx. ~20000 ≈ 14 dias de M1). Cada mil
candles leva ~10s para baixar.

## Ler o resultado

```
trades          101         <- abaixo de ~50: nada é conclusivo
winrate         36.6%
expectancy      0.099 R      <- A MÉTRICA. >0.1 e robusto = promissor; entre 0 e 0.1 = marginal; <0 = ruim
R acumulado     10.0 R
max drawdown    13.0 R       <- se for > R acumulado, a estratégia não paga o risco que corre
pior sequência  8 perdas     <- confira contra daily.maxLosses no config (bot vai parar muito)
breakeven wr    33.3%        <- winrate mínimo para não perder, dado o rr
veredito        MARGINAL ...
```

Regra de decisão:
- **AMOSTRA INSUFICIENTE / < 50 trades** → mais candles, ou afrouxar filtros, e rodar de novo.
- **PROMISSOR** (expectancy > 0.1 R e `R acumulado > 2 × drawdown`) → ligar em **demo**,
  não direto em real. Confirmar com dias de forward-test.
- **MARGINAL** → mudar **um** parâmetro, rodar de novo. Não empilhar mudanças.
- **RUIM** → não usar essa variante.

## Fluxo de melhoria (com a skill `strategy-review`)

1. Rode o baseline (params atuais do `config.json`).
2. Levante uma hipótese ("o stop bate cedo demais" / "estocástico entra atrasado").
3. Rode a variante com **uma** mudança.
4. Compare expectancy e drawdown. Melhorou de verdade? Aplique no `config.json`.
5. Ligue em demo. Depois de ~200 trades reais em demo, compare com o backtest — se
   divergirem muito, o backtest está otimista e a mudança não presta.

## Estender o backtester

Se precisar de algo que o `tools/backtest.ts` não faz (ex: outra métrica, curva de
equity em arquivo, varrer um range de parâmetros), edite o script. Mantenha a saída
com as mesmas linhas-chave (trades, winrate, expectancy, drawdown, veredito) para não
quebrar a leitura de quem usa esta skill.
