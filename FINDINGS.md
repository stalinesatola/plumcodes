# Findings — the search for an edge on Deriv

Six investigations, all with the same method: form a hypothesis, check it against the
nature of the price generator, implement it, backtest net of the real contract cost,
judge by **expectancy in R** (not win rate), require ≥ 150 trades before drawing a
conclusion.

Every number below is reproducible from the scripts in `tools/`.

---

## 1. Synthetic Volatility indices — Multipliers (`m1_scalp`, archived)

**Hypothesis.** M1 micro-trends on V75 / V10 can be scalped with a break-of-structure
+ EMA + Stochastic setup and a 1:2 stop/target.

**Result.** Small samples (4 000 candles) showed +0.1–0.4 R and looked promising.
Extending to 14 000 candles (~270 trades) collapsed every symbol toward zero:

| symbol | 4 000 candles | 14 000 candles |
|---|---|---|
| 1HZ10V | +0.42 R (74 tr) | −0.015 R (262 tr) |
| JD100  | +0.30 R (83 tr) | +0.056 R (267 tr) |
| R_75   | +0.18 R (71 tr) | +0.029 R (277 tr) |

**Verdict.** No edge. The 4 000-candle results were noise — the signature of a
strategy with no edge on a random process (small sample = noise, large sample → 0).

---

## 2. Symbol scan — all Multiplier-capable synthetics

`tools/scan-symbols.ts` across Volatility, Jump, Boom/Crash, Step (34 symbols) with
`m1_scalp` and `m1_amd`.

**Result.** With a large sample, expectancy converges to ~0 everywhere. Boom/Crash
(−0.16 to −0.39 R) and Step (−0.02 to −0.39 R) are clearly negative — they are
structurally asymmetric or have no trend to ride.

**Verdict.** No "best pair." Symbols differ only in candle smoothness (1s vs 2s tick),
volatility magnitude, and shape — not in edge.

---

## 3. Jump indices — the programmed jumps (`tools/jump-analyze.ts`)

**Hypothesis.** The jumps are large and "structural", so their timing or direction
might be predictable, or the post-jump move might be tradeable.

**Measured** (236 jumps across JD10–JD100, jump = |log-return| > 6σ local):

| property | result | implication |
|---|---|---|
| inter-jump interval | Poisson (`gapCV ≈ 1.0` on all 5) | memoryless — timing unpredictable |
| direction | 41–64 % "up", n ≈ 40–65 | fair coin |
| post-jump drift (1–15 min) | ≈ 0, sign flips between symbols | nothing to trade |
| autocorrelation between jumps | −0.36 to +0.21 | noise |

**Verdict.** No edge. The jump is a single re-pricing of random direction at a random
instant. Can't position before (unpredictable), can't profit after (zero drift), and a
straddle is −EV once you subtract the two-leg commission. Deriv's own spec confirms:
Poisson arrival, 50/50 direction, CSPRNG.

---

## 4. Last-digit contracts (`tools/digit-analyze.ts`)

**Hypothesis.** The CSPRNG has a last-digit bias, or serial dependence, big enough to
beat the payout margin.

**Measured** (R_100 & R_75, ~43 000 ticks each, different pip sizes):

| test | R_100 | R_75 | critical |
|---|---|---|---|
| χ² goodness-of-fit (uniform, df 9) | 5.83 | 11.91 | 16.9 @ 5 % |
| autocorrelation, lags 1–5 | all within ±1.96/√n | " | — |
| 10×10 transition-matrix χ² (df 81) | 77.9 | 66.9 | ~113 @ 1 % |
| runs test even/odd (z) | +0.75 | +0.96 | ±1.96 |

**Economic test.** With the *measured* frequencies and the *real* Deriv payouts, all
40 (symbol × contract × barrier) combinations have negative EV: best −1.7 %
(DIGITDIFF), worst −20 % (DIGITMATCH). The house margin is 1.9 %–17 %; the real digit
bias is ~0.3 % (noise).

**Verdict.** No edge, definitively. Digits are i.i.d. uniform within measurement
precision; the past does not predict the next digit.

---

## 5. Gold / USD spot (`frxXAUUSD`) — Multipliers (`tools/gold-*.ts`)

The real-market test. 200 573 M1 candles (2026-02 → 2026-08, ~145 trading days).

**Asset characterization** (`tools/gold-characterize.ts`):

| timeframe | return autocorrelation lag-1 | Variance Ratio | reading |
|---|---|---|---|
| M1 | −0.003 | ≈ 1.0 | random walk |
| M5 | +0.006 | ≈ 1.0 | random walk |
| M15 | −0.022 | 0.93 | very weak mean-reversion |

The only clear structure is the **volatility-by-hour cycle**: M1 median range peaks at
$3.07 during the London–NY overlap (13–14 UTC) and bottoms at ~$1.10 in the dead
hours. The London session (07–12 UTC) is the most mean-reverting (M5 VR(4) = 0.90).

**Contract choice.** Rise/Fall on Gold is daily-expiry only — useless intraday.
Multipliers (SL/TP in USD, no expiry) are the right fit. Real commission observed:
~0.00014 × multiplier of notional one-way (~0.00028 round-trip).

**Backtests** — 4 strategies, 23 runs, cost model embedded:

| strategy | best config | trades | win % | expectancy **gross** | expectancy **net** |
|---|---|---|---|---|---|
| `gold_meanrev_london` | rr 1.0 | 163 | 52.1 | **+0.043 R** | −0.134 R |
| `gold_ny_momo` | rr 1.5 | 220 | 42.3 | **+0.057 R** | −0.112 R |
| `gold_trend_m15` | 9/21 rr 1.5 | 416 | 40.6 | −0.047 R | −0.098 R |
| `gold_session_breakout` | chan16 | 508 | 30.9 | −0.073 R | −0.183 R |

**Verdict.** No usable edge. Two strategies (London mean-reversion, NY momentum) have a
real but tiny **gross** edge — smaller than the multiplier commission, which becomes
~0.15–0.20 R on the short stops those strategies need. Trend and breakout are negative
*before* cost: autocorrelation ≈ 0 kills trend-following.

---

## Conclusion

The limitation is the **product**, not the strategy or the effort:

- **Synthetics** are a cryptographically secure PRNG. No pattern exists by construction.
- **Real Gold intraday** on Deriv is near-random-walk on OHLC data, and the correct
  contract's commission consumes the sub-0.1 R gross edges that do exist.

A genuine edge would need a market with real order flow and volume (equities, futures,
spot FX) and data beyond OHLC — a different broker, a different capital base, a
different infrastructure.

The value that remains in this repo is the **engineering and the method**: a clean
trading engine, a cost-aware backtester, and a research loop that reaches an honest
"no" instead of an optimistic lie.
