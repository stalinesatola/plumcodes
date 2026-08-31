import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppConfig, ContractResult } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("learn");

interface ArmState {
  alpha: number; // Beta(alpha, beta) — wins + 1
  beta: number; // losses + 1
  trades: number;
  pnl: number;
  recent: number[]; // 1/0 dos ultimos N resultados
}

interface BotLearn {
  tuning: number; // -1..+1
  lastSlopePnl: number;
  disabledUntil: number;
  onProbation: boolean;
  arms: Record<string, ArmState>; // por tag (tipo de aposta)
}

interface PersistShape {
  bots: Record<string, BotLearn>;
  updatedAt: string;
}

function gaussian(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Amostra aproximada de Beta(a,b) via momento-gaussiano (suficiente p/ Thompson). */
function sampleBeta(a: number, b: number): number {
  const mean = a / (a + b);
  const varr = (a * b) / ((a + b) * (a + b) * (a + b + 1));
  const x = mean + gaussian() * Math.sqrt(varr);
  return Math.max(0.001, Math.min(0.999, x));
}

const freshArm = (): ArmState => ({ alpha: 1, beta: 1, trades: 0, pnl: 0, recent: [] });

/**
 * Camada adaptativa. Cada bot tem "bracos" (um por tipo de aposta / tag).
 * - Thompson sampling decide se a probabilidade estimada de vitoria cobre o payout.
 * - Winrate baixo por muitas operacoes -> bot desativado, depois volta em probation.
 * - Ajuste continuo `tuning` sobe/desce por hill-climbing conforme o PnL recente.
 * Estado persistido em disco: o aprendizado sobrevive a reinicios.
 */
export class Learner {
  private cfg: AppConfig["learning"];
  private state: PersistShape = { bots: {}, updatedAt: "" };
  private dirty = false;

  constructor(cfg: AppConfig) {
    this.cfg = cfg.learning;
    this.load();
    setInterval(() => this.flush(), 15_000).unref?.();
  }

  private load() {
    if (!this.cfg.enabled) return;
    try {
      this.state = JSON.parse(readFileSync(this.cfg.persistPath, "utf8"));
      log.info(`estado carregado (${Object.keys(this.state.bots).length} bots)`);
    } catch {
      log.info("sem estado previo, comecando do zero");
    }
  }

  flush() {
    if (!this.cfg.enabled || !this.dirty) return;
    try {
      mkdirSync(dirname(this.cfg.persistPath), { recursive: true });
      this.state.updatedAt = new Date().toISOString();
      writeFileSync(this.cfg.persistPath, JSON.stringify(this.state, null, 2));
      this.dirty = false;
    } catch (e) {
      log.error("falha ao persistir", (e as Error).message);
    }
  }

  private bot(id: string): BotLearn {
    let b = this.state.bots[id];
    if (!b) {
      b = { tuning: 0, lastSlopePnl: 0, disabledUntil: 0, onProbation: false, arms: {} };
      this.state.bots[id] = b;
    }
    return b;
  }

  private arm(id: string, tag: string): ArmState {
    const b = this.bot(id);
    return (b.arms[tag] ??= freshArm());
  }

  tuning(id: string): number {
    return this.cfg.enabled ? this.bot(id).tuning : 0;
  }

  isDisabled(id: string): { disabled: boolean; reason?: string } {
    if (!this.cfg.enabled) return { disabled: false };
    const b = this.bot(id);
    if (Date.now() < b.disabledUntil)
      return { disabled: true, reason: `learn-kill ate ${new Date(b.disabledUntil).toISOString()}` };
    return { disabled: false };
  }

  /** Multiplicador de stake sugerido (1.0 normal, menor em probation). */
  stakeScale(id: string): number {
    if (!this.cfg.enabled) return 1;
    return this.bot(id).onProbation ? this.cfg.probationStake : 1;
  }

  /**
   * Gate de EV: dada a aposta (tag) e o multiplicador de payout, decide operar.
   * - Cold-start: as primeiras `exploreTrades` operacoes de cada braco passam
   *   sem filtro (exploracao) para o bandit e o ML terem dados. Isso tem variancia
   *   alta e pode dar prejuizo — em conta real ponha `exploreTrades: 0`.
   * - Depois: precisa p_amostrado (Thompson) >= (1/payoutMult) * banditSafety.
   */
  shouldTrade(
    id: string,
    tag: string,
    payoutMult: number,
  ): { ok: boolean; pEst: number; need: number; explore: boolean } {
    const arm = this.arm(id, tag);
    if (!this.cfg.enabled) return { ok: true, pEst: 1, need: 0, explore: false };
    if (arm.trades < this.cfg.exploreTrades) return { ok: true, pEst: -1, need: 0, explore: true };
    const pEst = sampleBeta(arm.alpha, arm.beta);
    const need = (1 / Math.max(1.01, payoutMult)) * this.cfg.banditSafety;
    return { ok: pEst >= need, pEst, need, explore: false };
  }

  record(r: ContractResult) {
    if (!this.cfg.enabled) return;
    const b = this.bot(r.botId);
    const arm = this.arm(r.botId, r.tag);
    arm.trades++;
    arm.pnl += r.profit;
    arm.recent.push(r.isWin ? 1 : 0);
    if (arm.recent.length > this.cfg.window) arm.recent.shift();
    if (r.isWin) arm.alpha++;
    else arm.beta++;

    // hill-climb do tuning: se PnL do braco melhorou, mantem a direcao; senao inverte
    const slope = arm.pnl - b.lastSlopePnl;
    if (arm.trades % 10 === 0) {
      const dir = slope >= 0 ? Math.sign(b.tuning || 1) : -Math.sign(b.tuning || 1);
      b.tuning = Math.max(-1, Math.min(1, b.tuning + dir * this.cfg.tuneStep));
      b.lastSlopePnl = arm.pnl;
    }

    // kill / probation por winrate na janela.
    // Apostas de multiplicador (MULT*) tem alvo 1:2+ e winrate baixo e normal —
    // nelas o controle e o stop-loss por trade + limites diarios, nao o winrate.
    const wins = arm.recent.reduce((a, c) => a + c, 0);
    const wr = arm.recent.length ? wins / arm.recent.length : 1;
    const winrateKillable = !r.tag.startsWith("MULT");
    if (winrateKillable && arm.recent.length >= this.cfg.minSample && wr < this.cfg.killWinrate) {
      b.disabledUntil = Date.now() + 60 * 60_000; // 1h
      b.onProbation = true;
      arm.recent = [];
      log.warn(`${r.botId}/${r.tag} winrate ${(wr * 100).toFixed(1)}% < ${this.cfg.killWinrate * 100}% -> pausado 1h + probation`);
    } else if (b.onProbation && arm.recent.length >= this.cfg.minSample && wr >= this.cfg.killWinrate + 0.1) {
      b.onProbation = false;
      log.info(`${r.botId} saiu da probation (winrate ${(wr * 100).toFixed(1)}%)`);
    }

    this.dirty = true;
  }

  snapshot(id: string) {
    const b = this.bot(id);
    const arms = Object.fromEntries(
      Object.entries(b.arms).map(([tag, a]) => {
        const wins = a.recent.reduce((x, c) => x + c, 0);
        return [tag, { trades: a.trades, pnl: Number(a.pnl.toFixed(2)), wrWindow: a.recent.length ? +(wins / a.recent.length).toFixed(2) : null }];
      }),
    );
    return { tuning: +b.tuning.toFixed(2), probation: b.onProbation, disabled: Date.now() < b.disabledUntil, arms };
  }
}
