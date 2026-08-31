---
name: scan-symbols
description: >
  Comparar os índices/pares da Deriv e escolher em quais operar com o bot
  (Downloads/plumcodes). Use SEMPRE que o usuário pedir para "analisar os pares",
  "quais os melhores ativos/símbolos para operar", "testar em outros índices",
  "comparar V75 vs V100 vs Jump", "vale a pena Boom/Crash?", ou antes de trocar o
  `symbol` de um bot no config.json. Roda tools/scan-symbols.ts (backtest de cada
  símbolo) e interpreta o ranking — incluindo a armadilha de amostra pequena.
---

# Scan de símbolos — em quais operar

## Rodar

```
node --env-file=.env tools/scan-symbols.ts --candles 12000 --group vol
```

`--group`: `vol` (Volatility 10..100 + versões 1s), `jump` (Jump 10..100),
`boomcrash`, `step`, ou `all`. `--candles` ≈ minutos de M1 (12000 ≈ 8 dias).
`--strategies m1_scalp,m1_amd` para escolher quais testar. Usa cache em `data/`.

Imprime um ranking por **expectancy (R por trade)**, com trades, winrate, R acumulado,
drawdown e proporção long/short.

## Ler o resultado — a regra mais importante

**Amostra pequena mente.** Com 4000 candles você vê símbolos "PROMISSOR ***" com
+0.4 R em 70 trades. Rode os mesmos com 14000 candles e a expectancy **cai para perto
de zero**. Isso não é bug — é a assinatura de uma estratégia **sem edge real** num
processo aleatório: amostra pequena = ruído, amostra grande = converge para ~0.

Portanto:
1. Rode com `--candles 12000` ou mais. Ignore qualquer linha com < ~150 trades.
2. Só leve a sério diferenças de expectancy que **sobrevivem** ao aumento de amostra.
3. Confirme rodando `tools/backtest.ts <estrategia> <simbolo> --candles 15000` no
   top 2-3.

## O que realmente diferencia os símbolos (não é "edge")

| Característica | Efeito prático |
|---|---|
| **Tick de 1s (`1HZ..V`)** vs 2s (`R_..`) | 1s = candle M1 mais suave, menos pavios falsos, sinal de indicador mais limpo |
| **Volatilidade** (10 < 25 < 50 < 75 < 100) | menor vol = stop menor, dá para usar multiplicador maior com o mesmo risco em USD |
| **Boom/Crash** | assimétricos (spikes num lado só). Ruins para stop/alvo simétricos — o scan confirma expectancy negativa e o `m1_amd` quase não dispara |
| **Step Index** | passos fixos de 0.1, ~50/50 — sem tendência para surfar. Fica flat/negativo |
| **Jump (`JD..`)** | volatilidade + saltos ocasionais; nos scans ficou o "menos ruim" |
| **Comissão do multiplicador** | ~1.2% do stake ida-e-volta, parecida entre sintéticos |

## Recomendação padrão

Para `m1_scalp` (o setup ativo), os **menos ruins** com amostra grande são os índices
de volatilidade de 1s de baixa/média vol (`1HZ10V`, `1HZ25V`, `1HZ75V`), `R_75` e
`JD100` — todos com expectancy entre ~0 e +0.06 R. "Melhor" aqui = "mais perto de
empatar", não "lucrativo".

**Não existe par mágico na Deriv sintética.** O valor do bot é a gestão de risco +
aprendizado segurando as perdas, não uma vantagem estatística. Para edge de verdade
(VWAP, order flow, volume) seria preciso operar derivativos reais — outro projeto.

## Depois de escolher

1. Ajuste o `symbol` do bot no `config.json` (e o `multiplier` conforme a vol:
   mais vol → multiplicador menor para o stop em USD não estourar o stake).
2. `pm2 restart deriv-multibot`.
3. Forward-test em demo dias. Use `strategy-review` para conferir se a expectancy
   real bate com o scan.
