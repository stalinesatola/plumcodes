import type { AppConfig, BotConfig, ContractResult, Strategy, StrategyContext, TradeIntent } from "./types.ts";
import type { DerivClient } from "./deriv/client.ts";
import type { RiskManager } from "./risk/manager.ts";
import type { Learner } from "./learn/learner.ts";
import type { MlBridge } from "./ml/bridge.ts";
import { getStrategy } from "./strategies/index.ts";
import { buildFeatures } from "./util/features.ts";
import { lastDigit } from "./util/indicators.ts";
import { CandleAggregator, type Candle } from "./util/candles.ts";
import {
  computeStructure,
  structureGate,
  DEFAULT_STRUCTURE_CFG,
  type DailyStructure,
  type StructureCfg,
  type StructureMode,
} from "./util/structure.ts";
import { createLogger } from "./util/logger.ts";
import { journal } from "./util/journal.ts";
import { tgTradeOpen, tgTradeClose, tgRisk } from "./util/telegram.ts";

interface OpenMeta {
  tag: string;
  features: number[];
  payoutMult: number;
  stake: number;
  isMultiplier: boolean;
  openedAtMs: number;
  slUsd: number; // risco inicial em USD = 1R
  entry: number; // preco de entrada (0 = desconhecido, ex.: contrato adotado)
  dir: "up" | "down";
  stopDist: number; // distancia de preco ate o stop inicial
  multiplier: number;
  beDone: boolean; // stop ja movido para break-even
  peakR: number; // melhor R nao-realizado ja visto (para o trailing)
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

  // filtro de estrutura diaria (zonas H1 + vies) — compartilhado por todos os bots
  private h1: CandleAggregator | null = null;
  private structCfg: StructureCfg | null = null;
  private structMode: StructureMode = "block-counter";
  private structBandK = 1.2;
  private structure: DailyStructure | null = null;

  private currentContractId: number | null = null;
  private openMeta: OpenMeta | null = null;
  private martingaleStep = 0;
  private realizedPnl = 0;
  private wins = 0;
  private losses = 0;
  private stopped = false;
  private lastTradeEpoch = 0;
  private busy = false;
  private closing = false; // venda a mercado em curso (trailing / maxHold)

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
    structureCfg?: AppConfig["structure"];
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

    const sc = opts.structureCfg;
    if (sc?.enabled) {
      this.structCfg = {
        shortLookback: sc.shortLookback ?? DEFAULT_STRUCTURE_CFG.shortLookback,
        mediumLookback: sc.mediumLookback ?? DEFAULT_STRUCTURE_CFG.mediumLookback,
        invalLookback: sc.invalLookback ?? DEFAULT_STRUCTURE_CFG.invalLookback,
        atrPeriod: sc.atrPeriod ?? DEFAULT_STRUCTURE_CFG.atrPeriod,
        zoneAtrMult: sc.zoneAtrMult ?? DEFAULT_STRUCTURE_CFG.zoneAtrMult,
        emaFast: sc.emaFast ?? DEFAULT_STRUCTURE_CFG.emaFast,
        emaSlow: sc.emaSlow ?? DEFAULT_STRUCTURE_CFG.emaSlow,
      };
      this.structMode = sc.mode ?? "block-counter";
      this.structBandK = sc.zoneBandK ?? 1.2;
      this.h1 = new CandleAggregator(3600, this.structCfg.invalLookback + 40);
    }
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

  /** Semeia o histórico H1 usado pelo filtro de estrutura diária. */
  seedH1(candles: Candle[]) {
    if (!this.h1 || !this.structCfg) return;
    this.h1.seed(candles);
    this.structure = computeStructure(this.h1.closed, this.structCfg);
    if (this.structure) {
      const s = this.structure;
      this.log.info(
        `estrutura: viés ${s.bias} · S1 ${s.s1.toFixed(2)} R1 ${s.r1.toFixed(2)} · S2 ${s.s2.toFixed(2)} R2 ${s.r2.toFixed(2)} · inval ${s.invalLow.toFixed(2)}`,
      );
    }
  }

  /** Última estrutura calculada (para o status/monitor). */
  get structureSnapshot(): DailyStructure | null {
    return this.structure;
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
      structure: this.structure,
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

    // estrutura diária: recalcula a cada barra H1 fechada
    if (this.h1 && this.structCfg && this.h1.add(quote, epoch) !== null) {
      this.structure = computeStructure(this.h1.closed, this.structCfg) ?? this.structure;
    }

    this.rollDay();

    // gestao de posicao de multiplicador aberta
    if (this.openMeta?.isMultiplier && this.currentContractId !== null && !this.closing) {
      // trailing / break-even quando ja tem lucro
      this.manageOpenPosition(quote);
      // tempo maximo de permanencia
      if (this.cfg.maxHoldMinutes && candleClosed) {
        const heldMin = (Date.now() - this.openMeta.openedAtMs) / 60000;
        if (heldMin >= this.cfg.maxHoldMinutes) {
          this.closing = true;
          this.log.info(`hold ${heldMin.toFixed(1)}min >= ${this.cfg.maxHoldMinutes} -> vender`);
          void this.client.sellContract(this.currentContractId).catch((e) => {
            this.closing = false;
            this.log.error("sell falhou", (e as Error).message);
          });
        }
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

    // filtro de estrutura diária (compartilhado por todos os bots)
    if (this.structure && this.structCfg) {
      const dir: "up" | "down" =
        intent.contractType === "MULTUP" || intent.contractType === "CALL" ? "up" : "down";
      const g = structureGate(dir, quote, this.structure, this.structMode, this.structBandK);
      if (!g.ok) {
        this.log.debug(`skip ${intent.tag}: estrutura — ${g.reason}`);
        this.lastTradeEpoch = epoch;
        return;
      }
    }

    this.lastTradeEpoch = epoch;
    void this.enter(intent);
  }

  /** Gestao dinamica do stop de um multiplicador com lucro:
   *  1) ao atingir +breakEvenAtR, aperta o stop_loss da Deriv ate ~break-even (uma vez)
   *  2) depois de +trailAfterR, vende a mercado se o lucro recuar trailGapR abaixo do pico */
  private manageOpenPosition(quote: number): void {
    const m = this.openMeta;
    const ms = this.cfg.manageStop;
    if (!m || !ms || this.currentContractId === null || this.closing) return;
    if (m.entry <= 0 || m.stopDist <= 0 || m.multiplier <= 0 || m.slUsd <= 0) return; // ex.: adotado

    // P/L nao-realizado ~ stake * multiplicador * variacao% na direcao do trade
    const move = ((quote - m.entry) / m.entry) * (m.dir === "up" ? 1 : -1);
    const uR = (m.stake * m.multiplier * move) / m.slUsd;
    if (uR > m.peakR) m.peakR = uR;

    if (!m.beDone && ms.breakEvenAtR && uR >= ms.breakEvenAtR) {
      m.beDone = true;
      const beStop = Math.max(0.1, Number((m.stake * 0.02).toFixed(2))); // ~comissao do round-trip
      const cid = this.currentContractId;
      this.log.info(`+${uR.toFixed(2)}R → stop para break-even (SL ${beStop})`);
      void this.client
        .updateContract(cid, { stopLoss: beStop })
        .then(() =>
          journal({ ev: "adjust", ts: Date.now(), botId: this.id, contractId: cid, slPrice: m.entry, note: `break-even @ +${uR.toFixed(1)}R` }),
        )
        .catch((e) => {
          // nao repete (evita spam a cada tick) — o trailing manual ainda protege
          this.log.warn(`updateContract falhou, mantendo SL original: ${(e as Error).message}`);
        });
    }

    if (
      ms.trailAfterR &&
      ms.trailGapR &&
      m.peakR >= ms.trailAfterR &&
      uR <= m.peakR - ms.trailGapR
    ) {
      this.closing = true;
      this.log.info(`trailing: pico +${m.peakR.toFixed(2)}R, agora +${uR.toFixed(2)}R → vender`);
      void this.client.sellContract(this.currentContractId).catch((e) => {
        this.closing = false;
        this.log.error("sell (trailing) falhou", (e as Error).message);
      });
    }
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
        durationUnit: intent.durationUnit,
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
        entry: this.prices[this.prices.length - 1] ?? Number(buy.buyPrice) ?? 0,
        dir: intent.contractType === "MULTUP" || intent.contractType === "CALL" ? "up" : "down",
        stopDist: intent.stopDistance ?? 0,
        multiplier: intent.multiplier ?? 0,
        beDone: false,
        peakR: 0,
      };
      this.dayTrades++;
      this.log.info(
        `ENTRAR ${intent.tag} stake=${stake}` +
          (isMultiplier ? ` x${intent.multiplier} SL=${limitOrder?.stop_loss} TP=${limitOrder?.take_profit}` : ` mult=${payoutMult.toFixed(2)}`) +
          ` id=${buy.contractId} ${gate.explore ? "[explore]" : `[pEst ${gate.pEst.toFixed(2)}]`}`,
      );
      {
        const entryPx = this.prices[this.prices.length - 1] ?? Number(buy.buyPrice) ?? 0;
        const dir: "up" | "down" =
          intent.contractType === "MULTUP" || intent.contractType === "CALL" ? "up" : "down";
        const sd = intent.stopDistance ?? 0;
        const rrv = intent.rr ?? 2;
        const slPx = isMultiplier ? (dir === "up" ? entryPx - sd : entryPx + sd) : 0;
        const tpPx = isMultiplier ? (dir === "up" ? entryPx + rrv * sd : entryPx - rrv * sd) : 0;
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
          slPrice: slPx,
          tpPrice: tpPx,
        });
        const px = (n: number) => n.toFixed(this.symbol.startsWith("frx") ? 2 : 1);
        tgTradeOpen(
          `🟢 <b>ABRIU</b> ${this.id} · ${this.symbol}\n` +
            `${dir === "up" ? "▲ CALL/LONG" : "▼ PUT/SHORT"} @ ${px(entryPx)} · stake $${stake}\n` +
            (isMultiplier
              ? `SL ${px(slPx)} · TP ${px(tpPx)} · ×${intent.multiplier}`
              : `${intent.durationTicks}${intent.durationUnit ?? "t"} · payout ${(payoutMult - 1) * 100 | 0}%`),
        );
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
    this.closing = false;
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

    const rMult = meta?.slUsd ? profit / meta.slUsd : 0;
    const balAfter = Number(poc.balance_after ?? this.risk.balance);
    journal({
      ev: "close",
      ts: Date.now(),
      botId: this.id,
      contractId: Number(poc.contract_id),
      tag: result.tag,
      profit,
      isWin,
      rMultiple: rMult,
      balanceAfter: balAfter,
    });
    tgTradeClose(
      `${isWin ? "✅" : "❌"} <b>FECHOU</b> ${this.id} · ${isWin ? "WIN" : "LOSS"}\n` +
        `${result.tag}  ${profit >= 0 ? "+" : ""}${profit.toFixed(2)} USD  (${rMult >= 0 ? "+" : ""}${rMult.toFixed(2)}R)\n` +
        `bot: ${this.wins}W/${this.losses}L  pnl $${this.realizedPnl.toFixed(2)} · saldo $${balAfter.toFixed(2)}`,
    );

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
    tgRisk(`⚠️ <b>${this.id} PARADO</b>\n${reason}\nresultado do dia: ${this.dayWins}W/${this.dayLosses}L`);
  }

  get isOpen() {
    return this.currentContractId !== null;
  }

  /** Adota um contrato que já estava aberto na conta quando o bot (re)arrancou,
   *  para o evento de fecho ser processado normalmente (P/L no risco, diário,
   *  Telegram) em vez de ficar órfão. */
  adoptContract(c: { contractId: number; contractType?: string; buyPrice?: number; dateStart?: number }): boolean {
    if (this.currentContractId !== null) return false;
    const isMultiplier = /MULT/i.test(c.contractType ?? "");
    const stake = Number(c.buyPrice) || this.cfg.stake.base;
    this.currentContractId = Number(c.contractId);
    this.openMeta = {
      tag: "adopted",
      features: [],
      payoutMult: 0,
      stake,
      isMultiplier,
      openedAtMs: (Number(c.dateStart) || Math.floor(Date.now() / 1000)) * 1000,
      slUsd: stake,
      entry: 0, // desconhecido -> gestao dinamica de stop fica desligada p/ adotados
      dir: /UP|CALL|LONG/i.test(c.contractType ?? "") ? "up" : "down",
      stopDist: 0,
      multiplier: 0,
      beDone: false,
      peakR: 0,
    };
    this.risk.notifyOpen();
    this.log.info(`adotou contrato aberto ${c.contractId} (${c.contractType ?? "?"})`);
    return true;
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
