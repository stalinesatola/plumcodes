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
    /** [Opcional] teto rígido de risco por trade em % do saldo. Se o SL de um
     *  multiplicador passar disso, o stake é reduzido para caber. */
    maxRiskPerTradePct?: number;
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
  alerts?: {
    telegram?: {
      enabled: boolean;
      onTradeOpen?: boolean;
      onTradeClose?: boolean;
      onBotStartStop?: boolean;
      onRiskEvent?: boolean;
      heartbeatMinutes?: number;
    };
  };
  /** [Opcional] filtro de estrutura diária (portado do indicador XAUUSD_DailyStructure):
   *  zonas R1/S1/R2/S2 + invalidação + viés EMA H1. TODOS os bots consultam antes de entrar. */
  structure?: {
    enabled: boolean;
    mode?: "block-counter" | "require-zone";
    shortLookback?: number;
    mediumLookback?: number;
    invalLookback?: number;
    atrPeriod?: number;
    zoneAtrMult?: number;
    emaFast?: number;
    emaSlow?: number;
    zoneBandK?: number;
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
    /** [Opcional] se definido, o stake e ESTE % do saldo atual (nao o `base` fixo).
     *  Ex.: 5 = aposta 5% da banca a cada trade; o risco (slUsd) passa a flutuar
     *  com a distancia do stop em vez de ser fixo. */
    pctOfBalance?: number;
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
  /** [Opcional] filtro de regime por ADX(M15) (ideia do AURUM): so opera quando a
   *  forca da tendencia esta na faixa. Momentum: { min: 25 }. Reversao: { max: 22 }. */
  regimeAdx?: { period?: number; min?: number; max?: number };
  /** [Opcional] minutos minimos entre duas entradas do mesmo bot (anti-metralhadora). */
  minMinutesBetweenTrades?: number;
  /** [Opcional] gestao dinamica do stop de multiplicadores quando o trade ja tem lucro:
   *  - breakEvenAtR: ao atingir +N R nao-realizado, aperta o stop_loss ate ~break-even
   *  - trailAfterR / trailGapR: depois de +trailAfterR R, vende a mercado se o lucro
   *    recuar trailGapR R abaixo do pico (trailing manual — trava lucro real). */
  manageStop?: {
    breakEvenAtR?: number;
    trailAfterR?: number;
    trailGapR?: number;
  };
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
  /** unidade da duracao: "t" ticks (default), "s" segundos, "m" minutos.
   *  Indices (OTC_*) so aceitam CALL/PUT com "m" (15-60). */
  durationUnit?: "t" | "s" | "m";
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
  /** [Opcional] estrutura diaria (zonas H1 + vies) para a estrategia consultar */
  structure?: import("./util/structure.ts").DailyStructure | null;
  /** [Opcional] ADX(M15) atual — forca da tendencia (regime) */
  adxM15?: number | null;
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
