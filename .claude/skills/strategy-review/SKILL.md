---
name: strategy-review
description: >
  Ciclo de revisão das estratégias do bot Deriv em Downloads/plumcodes: aprender com
  os losses e melhorar o winrate/EV. Use SEMPRE que o usuário pedir para "revisar as
  estratégias", "melhorar o winrate", "analisar os resultados/losses", "o que está
  perdendo", "ajustar os parâmetros", "está dando prejuízo", ou depois de o bot rodar
  algumas horas/dias em demo ou real. Também use antes de promover qualquer estratégia
  de demo para conta real. Lê data/learn-state.json + data/bot.log (e opcionalmente o
  histórico da conta Deriv), calcula métricas por estratégia/aposta, classifica
  keep/tune/kill e propõe mudanças concretas em config.json e src/strategies/.
---

# Strategy Review — aprender com os losses

O objetivo é transformar o histórico de operações num conjunto pequeno de mudanças
concretas: quais estratégias manter, quais ajustar (e como), quais desligar. Não é
uma análise para inglês ver — cada rodada termina com um diff aplicável.

## Por que este ciclo existe

O bot já tem aprendizado automático em runtime (bandit de Thompson + modelo online +
hill-climb). Mas ele só ajusta *dentro* do espaço de parâmetros que já existe e é
lento para decisões estruturais ("essa estratégia não tem edge nenhum", "o stop está
apertado demais para esse símbolo", "faltou um filtro de regime"). Essa revisão é a
camada humana+Claude que fecha esse buraco.

## Passo 1 — Reunir os dados

Leia, na pasta do projeto:

- `data/learn-state.json` — estado do bandit por `botId` e por `tag` (tipo de aposta):
  `alpha/beta` (Beta), `trades`, `pnl`, janela `recent` (1/0), `tuning`, probation.
- `data/bot.log` — linhas `FECHADO WIN/LOSS <tag> lucro=… pnlBot=… dia W/L/T=…` e
  `ENTRAR …`. Dá a sequência temporal, horários e o `mult`/`pEst` de cada entrada.
- `config.json` — os parâmetros atuais de cada bot.

Se o usuário quiser a verdade contábil (não a reconstrução dos logs), busque o
histórico real da conta via a API:
`node -e` com o `DerivClient` chamando `{ statement: 1, limit: 200 }` ou
`{ profit_table: 1, limit: 200 }` (mensagens da nova Options API, ver
`src/deriv/client.ts`). Use isso para conferir PnL e comissões.

## Passo 2 — Calcular as métricas (por estratégia E por tag)

Para cada `botId` e para cada `tag`:

| Métrica | Como | Para quê |
|---|---|---|
| trades | contagem | tamanho de amostra — abaixo de ~50 nada é conclusivo |
| winrate | wins / trades | comparar com o breakeven |
| breakeven wr | `1 / (1 + rr)` p/ MULT; `1 / payoutMult` p/ binário | o alvo real |
| expectancy (R) | `média( lucro / risco )` | **a métrica-chave**: >0 = a estratégia ganha dinheiro |
| profit factor | `Σ ganhos / |Σ perdas|` | robustez; <1 = perde |
| pior sequência | máx. de losses seguidos | dimensionar cooldown / stop diário |
| drawdown | maior queda de pico a vale no PnL acumulado | risco de ruína |
| por hora do dia | winrate em blocos de 4h UTC | achar janelas ruins (regime) |

Escreva um script pequeno (`tools/analyze.mjs`, pode criar) que lê os dois arquivos e
imprime essa tabela — é mais rápido e reproduzível que ler à mão. Se as três últimas
revisões escreveram um script parecido, promova-o a `tools/analyze.ts` permanente.

## Passo 3 — Classificar

Para cada tag, decida:

- **KEEP** — expectancy > +0.05 R com ≥ 50 trades. Não mexer (deixa o bandit refinar).
- **TUNE** — expectancy entre -0.03 e +0.05 R, OU amostra pequena mas direção boa.
  Proponha *uma* mudança de parâmetro por vez (senão não dá para atribuir causa):
  - winrate perto do breakeven e stop batendo cedo → afrouxar `stopDistance`/`swingK`,
    ou reduzir `rr` de 2 para 1.5.
  - muitas entradas, winrate baixo → apertar o filtro (ex: `minSkew`, `edge`,
    `stochLookback` menor, exigir alinhamento de EMA mais forte).
  - perde só em certas horas → adicionar filtro de horário no `evaluate` ou no bot.
- **KILL** — expectancy < -0.03 R com ≥ 50 trades, ou profit factor < 0.8. Desative no
  `config.json` (`"enabled": false`) e registre no relatório *por quê*, para não
  reativar sem motivo.

Estratégias de dígito (`digits_*`): lembre que o RNG é uniforme. Winrate alto ≠ lucro.
Se a expectancy é negativa depois de centenas de trades, é o payout — nenhum ajuste de
parâmetro resolve. KILL sem dó.

## Passo 4 — Backtest antes de aplicar (só estratégias de candle)

Para mudanças em `m1_scalp` (ou qualquer `kind: "candle"`), rode o backtester com a
variante nova ANTES de ligar em conta real:

```
node --env-file=.env tools/backtest.ts m1_scalp R_75 --candles 8000 --param <k>=<v>
```

Compare expectancy/drawdown da variante nova vs a atual. Ver a skill `backtest-strategy`.
Estratégias de dígito não são backtestáveis — só forward-test em demo.

## Passo 5 — Relatório (template fixo)

```
# Revisão de estratégias — <data> — <fonte: logs / conta real> — <período coberto>

## Resumo
<2-3 frases: o bot está ganhando/perdendo, quanto, e a mudança mais importante proposta.>

## Métricas por estratégia
<tabela do passo 2>

## Decisões
| tag | veredito | evidência | mudança proposta |
|-----|----------|-----------|------------------|
| ... | KEEP/TUNE/KILL | expectancy X R, N trades, ... | ... |

## Diffs a aplicar
<blocos de diff concretos para config.json e/ou src/strategies/index.ts>

## Backtest (se aplicável)
<antes vs depois>

## Próximo checkpoint
<quando revisar de novo e o que observar>
```

## Passo 6 — Aplicar

Só depois do OK do usuário: aplique os diffs, rode `npx tsc --noEmit`, e lembre o
usuário de `pm2 restart plumcodes`. Se mudou parâmetros que invalidam o
aprendizado acumulado de uma tag, sugira apagar só aquela entrada em
`data/learn-state.json` (não o arquivo todo).

## Regras de ouro

- **Uma variável por vez.** Mudou stop e filtro juntos, não sabe qual funcionou.
- **Amostra manda.** 10 trades não dizem nada. Diga "amostra insuficiente" em vez de
  inventar história.
- **Expectancy > winrate.** Uma estratégia 40% com 1:2 ganha; uma 88% com payout de
  +2% perde. Sempre reporte as duas mas decida pela expectancy.
- **Honestidade.** Se tudo está com expectancy negativa, a conclusão é "reduzir
  exposição / voltar para demo", não "otimizar mais um pouco".
