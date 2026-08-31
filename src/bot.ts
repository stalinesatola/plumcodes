import type { BotConfig, ContractResult, Strategy, StrategyContext, TradeIntent } from "./types.ts";
import type { DerivClient } from "./deriv/client.ts";
import type { RiskManager } from "./risk/manager.ts";
import type { Learner } from "./learn/learner.ts";
import type { MlBridge } from "./ml/bridge.ts";
import { getStrategy } from "./strategies/index.ts";
import { buildFeatures } from "./util/features.ts";
import { lastDigit } from "./util/indicators.ts";
import { CandleAggregator, type Candle } from "./util/candles.ts";
import { createLogger } from "./util/logger.ts";
import { journal } from "./util/journal.ts";

interface OpenMeta {
  tag: string;
  features: number[];
  payoutMult: number;
  stake: number;
  isMultiplier: boolean;
  openedAtMs: number;
  slUsd: number;
}

export class Bot {
  readonly id: string;
  readonly symbol: string;
  private cfg: BotConfig;
  private strat: Strategy;
  private client: DerivClient;
  private risk: RiskManager;
  private learner: Learner;
  private ml: MlBridge;
  private currency: string;
  private log;

  private prices: number[] = [];
  private digits: number[] = [];
  private pipSize = 2;
  private maxSeries = 600;
  private candles: CandleAggregator | null = null;

  private currentContractId: number | null = null;
  private openMeta: OpenMeta | null = null;
  private martingaleStep = 0;
  private realizedPnl = 0;
  private wins = 0;
  private losses = 0;
  private stopped = false;
  private lastTradeEpoch = 0;
  private busy = false;

  // limites diarios de scalping
  private dayKey = "";
  private dayWins = 0;
  private dayLosses = 0;
  private dayTrades = 0;

  constructor(opts: {
    cfg: BotConfig;
    client: DerivClient;
    risk: RiskManager;
    learner: Learner;
    ml: MlBridge;
    currency: string;
  }) {
    this.cfg = opts.cfg;
    this.id = opts.cfg.id;
    this.symbol = opts.cfg.symbol;
    this.strat = getStrategy(opts.cfg.strategy);
    this.client = opts.client;
    this.risk = opts.risk;
    this.learner = opts.learner;
    this.ml = opts.ml;
    this.currency = opts.currency;
    this.log = createLogger(`bot:${this.id}`);
    if (this.strat.kind === "candle") this.candles = new CandleAggregator(60, 400);
  }

  needsCandles() {
    return this.strat.kind === "candle";
  }

  seedPrices(prices: number[], pipSize: number) {
    this.pipSize = pipSize;
    this.prices = prices.slice(-this.maxSeries);
    this.digits = this.prices.map((q) => lastDigit(q, pipSize));
    this.log.info(`seed ${this.prices.length} precos pip=${pipSize} strat=${this.strat.name}`);
  }

  seedCandles(candles: Candle[]) {
    this.candles?.seed(candles);
    this.log.info(`seed ${candles.length} candles M1`);
  }

  private rollDay() {
    const key = new Date().toISOString().slice(0, 10);
    if (key !== this.dayKey) {
      this.dayKey = key;
      this.dayWins = this.dayLosses = this.dayTrades = 0;
      if (this.stopped && this.stopReason.startsWith("daily")) {
        this.stopped = false;
        this.log.info(`novo dia ${key}: limites diarios resetados, bot reativado`);
      }
    }
  }
  private stopReason = "";

  private dailyCapHit(): string | null {
    const d = this.cfg.daily;
    if (!d) return null;
    if (d.maxTrades && this.dayTrades >= d.maxTrades) return `daily maxTrades ${d.maxTrades}`;
    if (d.maxWins && this.dayWins >= d.maxWins) return `daily maxWins ${d.maxWins}`;
    if (d.maxLosses && this.dayLosses >= d.maxLosses) return `daily maxLosses ${d.maxLosses}`;
    return null;
  }

  private baseStake(): number {
    const { base, martingale } = this.cfg.stake;
    let s = base;
    if (martingale.enabled && this.martingaleStep > 0) {
      s = base * Math.pow(martingale.factor, this.martingaleStep);
    }
    s *= this.learner.stakeScale(this.id);
    return Math.max(0.35, Number(s.toFixed(2)));
  }

  private ctx(candleClosed: boolean): StrategyContext {
    return {
      prices: this.prices,
      digits: this.digits,
      candles: this.candles?.closed ?? [],
      candleClosed,
      price: this.prices[this.prices.length - 1] ?? 0,
      pipSize: this.pipSize,
      params: this.cfg.params,
      tuning: this.learner.tuning(this.id),
      defaultDurationTicks: this.cfg.durationTicks,
    };
  }

  onTick(quote: number, epoch: number, pipSize: number) {
    if (pipSize) this.pipSize = pipSize;
    this.prices.push(quote);
    this.digits.push(lastDigit(quote, this.pipSize));
    if (this.prices.length > this.maxSeries) this.prices.shift();
    if (this.digits.length > this.maxSeries) this.digits.shift();

    let candleClosed = false;
    if (this.candles) candleClosed = this.candles.add(quote, epoch) !== null;

    this.rollDay();

    // gestao de posicao de multiplicador aberta (tempo maximo)
    if (this.openMeta?.isMultiplier && this.cfg.maxHoldMinutes && candleClosed) {
      const heldMin = (Date.now() - this.openMeta.openedAtMs) / 60000;
      if (heldMin >= this.cfg.maxHoldMinutes && this.currentContractId !== null) {
        this.log.info(`hold ${heldMin.toFixed(1)}min >= ${this.cfg.maxHoldMinutes} -> vender`);
        void this.client.sellContract(this.currentContractId).catch((e) =>
          this.log.error("sell falhou", (e as Error).message),
        );
      }
    }

    if (this.stopped || this.busy || this.currentContractId !== null) return;
    if (this.strat.kind !== "candle" && this.prices.length < this.strat.warmup) return;
    if (epoch === this.lastTradeEpoch) return;

    const cap = this.dailyCapHit();
    if (cap) {
      this.stop(cap);
      return;
    }
    if (this.learner.isDisabled(this.id).disabled) return;

    const intent = this.strat.evaluate(this.ctx(candleClosed));
    if (!intent) return;

    this.lastTradeEpoch = epoch;
    void this.enter(intent);
  }

  private async enter(intent: TradeIntent) {
    this.busy = true;
    try {
      let stake = this.baseStake();
      const isMultiplier = intent.multiplier !== undefined;

      let limitOrder: { stop_loss?: number; take_profit?: number } | undefined;
      let slUsd = 0;
      if (isMultiplier) {
        const price = this.prices[this.prices.length - 1] ?? 0;
        const riskPct = this.cfg.riskPerTradePct ?? 1;
        const riskBudget = Math.max(0.35, (this.risk.balance * riskPct) / 100);
        // fracao do stake perdida se o preco andar ate o swing
        const stopFraction =
          intent.stopDistance && price > 0 ? (intent.multiplier! * intent.stopDistance) / price : 1;
        if (stopFraction >= 1) {
          // swing alem do ponto de auto-fecho: risco = o proprio stake
          stake = Math.min(50, Math.max(1, Number(riskBudget.toFixed(2))));
          slUsd = Number((stake * 0.95).toFixed(2));
        } else {
          // dimensiona o stake para a perda no swing bater no orcamento de risco
          stake = Math.min(50, Math.max(1, Number((riskBudget / stopFraction).toFixed(2))));
          slUsd = Math.min(
            Number((stake * 0.95).toFixed(2)),
            Math.max(0.1, Number((stake * stopFraction).toFixed(2))),
          );
        }
        const tpUsd = Number((slUsd * (intent.rr ?? 2)).toFixed(2));
        limitOrder = { stop_loss: slUsd, take_profit: tpUsd };
      }
      const features = buildFeatures(this.ctx(false), intent);

      const proposal = await this.client.getProposal({
        symbol: this.symbol,
        contractType: intent.contractType,
        amount: stake,
        durationTicks: intent.durationTicks,
        currency: this.currency,
        barrier: intent.barrier,
        multiplier: intent.multiplier,
        limitOrder,
      });
      // Para multiplicador com SL=X e TP=rr*X: vitoria devolve (1+rr)*X sobre o
      // risco X, entao o "multiplo de payout" equivalente e (1 + rr).
      // Breakeven de winrate = 1 / (1 + rr)  (ex: rr=2 -> 33%).
      const payoutMult = isMultiplier ? 1 + (intent.rr ?? 2) : proposal.payout / stake;

      const gate = this.learner.shouldTrade(this.id, intent.tag, payoutMult);
      if (!gate.ok) {
        this.log.debug(`skip ${intent.tag}: pEst ${gate.pEst.toFixed(3)} < need ${gate.need.toFixed(3)}`);
        return;
      }

      if (this.ml.enabled && !gate.explore) {
        const pWin = await this.ml.predict(`${this.id}|${intent.tag}`, features);
        if (pWin !== null) {
          const edge = pWin * payoutMult - 1;
          if (edge < this.ml.minEdge) {
            this.log.debug(`skip ${intent.tag}: ML edge ${edge.toFixed(3)} < ${this.ml.minEdge}`);
            return;
          }
        }
      }

      const rg = this.risk.canTrade(this.currentContractId !== null ? 1 : 0);
      if (!rg.ok) {
        this.log.debug(`skip ${intent.tag}: risco ${rg.reason}`);
        return;
      }

      this.risk.notifyOpen();
      const buy = await this.client.buyProposal(proposal.id, proposal.askPrice);
      this.currentContractId = buy.contractId;
      this.openMeta = {
        tag: intent.tag,
        features,
        payoutMult,
        stake,
        isMultiplier,
        openedAtMs: Date.now(),
        slUsd: slUsd || stake,
      };
      this.dayTrades++;
      this.log.info(
        `ENTRAR ${intent.tag} stake=${stake}` +
          (isMultiplier ? ` x${intent.multiplier} SL=${limitOrder?.stop_loss} TP=${limitOrder?.take_profit}` : ` mult=${payoutMult.toFixed(2)}`) +
          ` id=${buy.contractId} ${gate.explore ? "[explore]" : `[pEst ${gate.pEst.toFixed(2)}]`}`,
      );
      if (isMultiplier) {
        const entryPx = this.prices[this.prices.length - 1] ?? Number(buy.buyPrice) ?? 0;
        const dir: "up" | "down" = intent.contractType === "MULTUP" ? "up" : "down";
        const sd = intent.stopDistance ?? 0;
        const rrv = intent.rr ?? 2;
        journal({
          ev: "open",
          ts: Date.now(),
          botId: this.id,
          strategy: this.strat.name,
          symbol: this.symbol,
          tag: intent.tag,
          contractId: buy.contractId,
          dir,
          entry: entryPx,
          stake,
          multiplier: intent.multiplier ?? 0,
          stopDist: sd,
          slPrice: dir === "up" ? entryPx - sd : entryPx + sd,
          tpPrice: dir === "up" ? entryPx + rrv * sd : entryPx - rrv * sd,
        });
      }
      await this.client.trackContract(buy.contractId);
    } catch (e) {
      this.risk.notifyClosed();
      this.currentContractId = null;
      this.openMeta = null;
      this.log.error("falha ao entrar", (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  onContractUpdate(poc: any) {
    if (!poc || Number(poc.contract_id) !== this.currentContractId || !poc.is_sold) return;
    const meta = this.openMeta;
    const profit = Number(poc.profit);
    const isWin = profit >= 0;

    const result: ContractResult = {
      contractId: Number(poc.contract_id),
      botId: this.id,
      tag: meta?.tag ?? "?",
      buyPrice: Number(poc.buy_price),
      payout: Number(poc.payout),
      profit,
      isWin,
      payoutMult: meta?.payoutMult ?? 0,
      features: meta?.features ?? [],
    };

    this.risk.notifyClosed();
    this.currentContractId = null;
    this.openMeta = null;
    this.realizedPnl += profit;
    if (isWin) {
      this.wins++;
      this.dayWins++;
    } else {
      this.losses++;
      this.dayLosses++;
    }

    const mg = this.cfg.stake.martingale;
    if (mg.enabled && !(meta?.isMultiplier)) {
      this.martingaleStep = isWin ? 0 : Math.min(this.martingaleStep + 1, mg.maxSteps);
    }

    this.risk.recordResult(result);
    this.learner.record(result);
    if (result.features.length) this.ml.observe(`${this.id}|${result.tag}`, result.features, isWin);

    journal({
      ev: "close",
      ts: Date.now(),
      botId: this.id,
      contractId: Number(poc.contract_id),
      tag: result.tag,
      profit,
      isWin,
      rMultiple: meta?.slUsd ? profit / meta.slUsd : 0,
      balanceAfter: Number(poc.balance_after ?? this.risk.balance),
    });

    this.log.info(
      `FECHADO ${isWin ? "WIN" : "LOSS"} ${result.tag} lucro=${profit.toFixed(2)} ` +
        `pnlBot=${this.realizedPnl.toFixed(2)} dia W/L/T=${this.dayWins}/${this.dayLosses}/${this.dayTrades}`,
    );

    const cap = this.dailyCapHit();
    if (cap) this.stop(cap);
    else if (this.realizedPnl <= -Math.abs(this.cfg.botStopLossUsd))
      this.stop(`bot stop-loss ${this.realizedPnl.toFixed(2)}`);
    else if (this.realizedPnl >= Math.abs(this.cfg.botTakeProfitUsd))
      this.stop(`bot take-profit ${this.realizedPnl.toFixed(2)}`);
  }

  stop(reason: string) {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.log.warn(`PARADO: ${reason}`);
  }

  get isOpen() {
    return this.currentContractId !== null;
  }

  get status() {
    return {
      id: this.id,
      symbol: this.symbol,
      strategy: this.strat.name,
      stopped: this.stopped,
      open: this.currentContractId !== null,
      pnl: Number(this.realizedPnl.toFixed(2)),
      wins: this.wins,
      losses: this.losses,
      wr: this.wins + this.losses ? +(this.wins / (this.wins + this.losses)).toFixed(2) : null,
      day: { w: this.dayWins, l: this.dayLosses, t: this.dayTrades },
      mg: this.martingaleStep,
      learn: this.learner.snapshot(this.id),
    };
  }
}
