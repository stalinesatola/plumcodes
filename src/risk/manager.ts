import type { AppConfig, ContractResult } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("risk");

export type TradeGate =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Guarda-costas da conta inteira. Toda ordem passa por canTrade() antes de sair,
 * e todo resultado alimenta recordResult().
 */
export class RiskManager {
  private cfg: AppConfig["risk"];
  private resetUtc: string;

  private dayStartBalance = 0;
  private currentBalance = 0;
  private dayKey = "";
  private lossStreak = 0;
  private pausedUntil = 0;
  private halted: string | null = null;
  private openContracts = 0;

  constructor(cfg: AppConfig) {
    this.cfg = cfg.risk;
    this.resetUtc = cfg.session.dailyResetUtc;
  }

  init(balance: number) {
    this.currentBalance = balance;
    this.dayStartBalance = balance;
    this.dayKey = this.computeDayKey();
    log.info(`sessao iniciada saldo=${balance} dia=${this.dayKey}`);
  }

  private computeDayKey(): string {
    const [h, m] = this.resetUtc.split(":").map(Number);
    const now = new Date();
    const shifted = new Date(now.getTime() - ((h ?? 0) * 3600 + (m ?? 0) * 60) * 1000);
    return shifted.toISOString().slice(0, 10);
  }

  private rollDayIfNeeded() {
    const key = this.computeDayKey();
    if (key !== this.dayKey) {
      log.info(`novo dia ${key}: reset de metricas (saldo base ${this.currentBalance})`);
      this.dayKey = key;
      this.dayStartBalance = this.currentBalance;
      this.lossStreak = 0;
      if (this.halted && this.halted.startsWith("daily")) this.halted = null;
    }
  }

  updateBalance(balance: number) {
    this.currentBalance = balance;
  }

  get balance(): number {
    return this.currentBalance;
  }

  get pnlToday(): number {
    return this.currentBalance - this.dayStartBalance;
  }

  get pnlTodayPct(): number {
    if (this.dayStartBalance <= 0) return 0;
    return (this.pnlToday / this.dayStartBalance) * 100;
  }

  notifyOpen() {
    this.openContracts++;
  }
  notifyClosed() {
    this.openContracts = Math.max(0, this.openContracts - 1);
  }

  canTrade(botOpenContracts: number): TradeGate {
    this.rollDayIfNeeded();

    if (this.halted) return { ok: false, reason: this.halted };

    if (this.currentBalance <= this.cfg.hardFloorBalance) {
      this.halted = `hard-floor: saldo ${this.currentBalance} <= ${this.cfg.hardFloorBalance}`;
      log.error(this.halted);
      return { ok: false, reason: this.halted };
    }

    if (this.pnlTodayPct <= -Math.abs(this.cfg.dailyStopLossPct)) {
      this.halted = `daily-stop-loss: ${this.pnlTodayPct.toFixed(2)}% <= -${this.cfg.dailyStopLossPct}%`;
      log.warn(this.halted);
      return { ok: false, reason: this.halted };
    }

    if (this.pnlTodayPct >= Math.abs(this.cfg.dailyTakeProfitPct)) {
      this.halted = `daily-take-profit: ${this.pnlTodayPct.toFixed(2)}% >= ${this.cfg.dailyTakeProfitPct}%`;
      log.info(this.halted);
      return { ok: false, reason: this.halted };
    }

    if (Date.now() < this.pausedUntil) {
      return { ok: false, reason: `cooldown ate ${new Date(this.pausedUntil).toISOString()}` };
    }

    if (this.openContracts >= this.cfg.maxConcurrentBots) {
      return { ok: false, reason: `maxConcurrentBots (${this.cfg.maxConcurrentBots}) atingido` };
    }

    if (botOpenContracts >= this.cfg.maxOpenContractsPerBot) {
      return { ok: false, reason: `maxOpenContractsPerBot (${this.cfg.maxOpenContractsPerBot}) atingido` };
    }

    return { ok: true };
  }

  recordResult(r: ContractResult) {
    if (r.isWin) {
      this.lossStreak = 0;
    } else {
      this.lossStreak++;
      if (this.lossStreak >= this.cfg.globalLossStreakPause) {
        this.pausedUntil = Date.now() + this.cfg.cooldownMinutes * 60_000;
        log.warn(
          `loss streak ${this.lossStreak} -> cooldown ${this.cfg.cooldownMinutes}min`,
        );
        this.lossStreak = 0;
      }
    }
    log.info(
      `resultado ${r.botId} ${r.isWin ? "WIN" : "LOSS"} lucro=${r.profit.toFixed(2)} ` +
        `pnlDia=${this.pnlToday.toFixed(2)} (${this.pnlTodayPct.toFixed(2)}%)`,
    );
  }

  get status() {
    return {
      balance: this.currentBalance,
      dayStartBalance: this.dayStartBalance,
      pnlToday: this.pnlToday,
      pnlTodayPct: this.pnlTodayPct,
      lossStreak: this.lossStreak,
      openContracts: this.openContracts,
      halted: this.halted,
      pausedUntil: this.pausedUntil > Date.now() ? new Date(this.pausedUntil).toISOString() : null,
    };
  }

  get isHalted() {
    return this.halted !== null;
  }
}
