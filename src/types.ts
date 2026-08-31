export interface AppConfig {
  account: { mode: "demo" | "real"; currency: string };
  risk: {
    dailyStopLossPct: number;
    dailyTakeProfitPct: number;
    maxConcurrentBots: number;
    maxOpenContractsPerBot: number;
    hardFloorBalance: number;
    globalLossStreakPause: number;
    cooldownMinutes: number;
  };
  learning: {
    enabled: boolean;
    window: number;
    minSample: number;
    exploreTrades: number;
    killWinrate: number;
    probationStake: number;
    banditSafety: number;
    tuneStep: number;
    persistPath: string;
  };
  ml: {
    enabled: boolean;
    pythonPath: string;
    scriptPath: string;
    minEdge: number;
  };
  session: {
    dailyResetUtc: string;
    reconnect: { pingIntervalSec: number; maxBackoffSec: number };
  };
  bots: BotConfig[];
}

export interface BotConfig {
  id: string;
  enabled: boolean;
  strategy: string;
  symbol: string;
  durationTicks: number;
  stake: {
    base: number;
    martingale: { enabled: boolean; factor: number; maxSteps: number };
  };
  params: Record<string, number>;
  botStopLossUsd: number;
  botTakeProfitUsd: number;
  /** [Opcional] % do saldo arriscada por trade (usado por estrategias de multiplicador). */
  riskPerTradePct?: number;
  /** [Opcional] limites diarios de scalping: para o bot ate o proximo dia UTC. */
  daily?: { maxWins?: number; maxLosses?: number; maxTrades?: number };
  /** [Opcional] fecha posicao de multiplicador aberta ha mais de N minutos. */
  maxHoldMinutes?: number;
}

export type ContractType =
  | "CALL"
  | "PUT"
  | "DIGITMATCH"
  | "DIGITDIFF"
  | "DIGITOVER"
  | "DIGITUNDER"
  | "DIGITEVEN"
  | "DIGITODD"
  | "MULTUP"
  | "MULTDOWN";

export interface TradeIntent {
  contractType: ContractType;
  /** digito (0-9) para MATCH/DIFF/OVER/UNDER */
  barrier?: string;
  durationTicks: number;
  /** rotulo curto p/ logs e para a camada de aprendizado agrupar por tipo de aposta */
  tag: string;
  /** --- so para multiplicadores (MULTUP/MULTDOWN) --- */
  multiplier?: number;
  /** distancia de preco ate o stop (swing). O bot converte em USD. */
  stopDistance?: number;
  /** razao risco:retorno para o take-profit (ex: 2 = 1:2) */
  rr?: number;
}

export interface Candle {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface StrategyContext {
  prices: number[];
  digits: number[];
  candles: Candle[];
  /** true no tick em que um candle acabou de fechar */
  candleClosed: boolean;
  price: number;
  pipSize: number;
  params: Record<string, number>;
  /** ajuste continuo aprendido pela camada adaptativa (-1..+1, default 0) */
  tuning: number;
  defaultDurationTicks: number;
}

export interface Strategy {
  readonly name: string;
  readonly warmup: number;
  readonly kind: "riseFall" | "digits" | "candle";
  evaluate(ctx: StrategyContext): TradeIntent | null;
}

export interface ContractResult {
  contractId: number;
  botId: string;
  tag: string;
  buyPrice: number;
  payout: number;
  profit: number;
  isWin: boolean;
  /** payout / stake no momento da compra (multiplicador) */
  payoutMult: number;
  features: number[];
}
