import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { createLogger } from "../util/logger.ts";

const log = createLogger("deriv");

export interface AccountInfo {
  accountId: string;
  balance: number;
  currency: string;
  isDemo: boolean;
  group: string;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Cliente da **nova Options API** da Deriv.
 *
 * Diferenca chave para a API v3 antiga: nao existe mensagem `authorize`.
 * A autenticacao e feita assim:
 *   1. REST GET  /trading/v1/options/accounts            -> lista de contas (accountId)
 *   2. REST POST /trading/v1/options/accounts/{id}/otp   -> URL de WebSocket com ?otp=... (vale 120s, uso unico)
 *   3. abre o WebSocket nessa URL; ja vem autenticado.
 * A cada reconexao pedimos um OTP novo.
 *
 * As mensagens dentro do socket (proposal, buy, ticks, ticks_history,
 * proposal_open_contract, balance, forget) sao quase iguais as da v3, com
 * `symbol` renomeado para `underlying_symbol` em proposal/buy.
 */
export class DerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private pingTimer: NodeJS.Timeout | null = null;
  private backoff = 1;
  private closedByUser = false;

  private token: string;
  private appId: string;
  private restBase: string;
  private mode: "demo" | "real";
  private accountIdOverride: string | undefined;
  private pingIntervalSec: number;
  private maxBackoffSec: number;

  private account: AccountInfo | null = null;
  private tickSubs = new Set<string>();
  private wantBalanceSub = false;

  constructor(opts: {
    token: string;
    appId: string;
    restBase: string;
    mode: "demo" | "real";
    accountId?: string;
    pingIntervalSec: number;
    maxBackoffSec: number;
  }) {
    super();
    this.token = opts.token;
    this.appId = opts.appId;
    this.restBase = opts.restBase.replace(/\/$/, "");
    this.mode = opts.mode;
    this.accountIdOverride = opts.accountId;
    this.pingIntervalSec = opts.pingIntervalSec;
    this.maxBackoffSec = opts.maxBackoffSec;
  }

  // ---------- REST ----------

  private async rest(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
    const res = await fetch(`${this.restBase}${path}`, {
      method,
      headers: {
        "Deriv-App-ID": this.appId,
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* keep {} */
    }
    if (!res.ok) {
      const err = json?.errors?.[0];
      throw new Error(`REST ${method} ${path} -> ${res.status} ${err?.code ?? ""} ${err?.message ?? text}`);
    }
    return json;
  }

  /** Descobre o accountId a usar (demo/real) e o saldo inicial. */
  async resolveAccount(): Promise<AccountInfo> {
    const res = await this.rest("/trading/v1/options/accounts", "GET");
    const list: any[] = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
    log.info(`contas: ${list.map((a) => `${a.account_id}(${a.account_type})`).join(", ") || "nenhuma"}`);

    const wantType = this.mode === "demo" ? "demo" : "real";
    let acc = this.accountIdOverride
      ? list.find((a) => a.account_id === this.accountIdOverride)
      : list.find((a) => a.account_type === wantType && a.status === "active");

    if (!acc && this.mode === "demo") {
      log.info("sem conta demo, criando...");
      const created = await this.rest("/trading/v1/options/accounts", "POST", {
        currency: "USD",
        group: "row",
        account_type: "demo",
      });
      acc = Array.isArray(created.data) ? created.data[0] : created.data;
    }
    if (!acc) throw new Error(`nenhuma conta '${wantType}' encontrada para este token`);

    this.account = {
      accountId: acc.account_id,
      balance: Number(acc.balance),
      currency: acc.currency,
      isDemo: acc.account_type === "demo",
      group: acc.group,
    };
    return this.account;
  }

  private async getOtpUrl(): Promise<string> {
    if (!this.account) throw new Error("resolveAccount() nao foi chamado");
    const res = await this.rest(
      `/trading/v1/options/accounts/${this.account.accountId}/otp`,
      "POST",
    );
    const url = res?.data?.url;
    if (!url) throw new Error("resposta de OTP sem url");
    return url;
  }

  // ---------- WebSocket ----------

  async connect(): Promise<AccountInfo> {
    this.closedByUser = false;
    if (!this.account) await this.resolveAccount();

    const wsUrl = await this.getOtpUrl();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.on("open", async () => {
        log.info("socket aberto (autenticado via OTP)");
        this.backoff = 1;
        this.startPing();
        try {
          await this.restoreSubscriptions();
          this.emit("open", this.account);
          resolve(this.account!);
        } catch (e) {
          reject(e as Error);
        }
      });

      ws.on("message", (raw) => this.onMessage(raw.toString()));

      ws.on("close", (code) => {
        log.warn(`socket fechado code=${code}`);
        this.cleanupSocket();
        this.emit("close", code);
        if (!this.closedByUser) this.scheduleReconnect();
      });

      ws.on("error", (err) => log.error("erro no socket", err.message));
    });
  }

  disconnect() {
    this.closedByUser = true;
    this.stopPing();
    this.ws?.close();
  }

  private cleanupSocket() {
    this.stopPing();
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("socket fechado"));
    }
    this.pending.clear();
  }

  private scheduleReconnect() {
    const delay = Math.min(this.backoff, this.maxBackoffSec) * 1000;
    log.info(`reconectando em ${delay / 1000}s (novo OTP)`);
    setTimeout(() => {
      this.backoff = Math.min(this.backoff * 2, this.maxBackoffSec);
      this.connect().catch((e) => log.error("falha ao reconectar", (e as Error).message));
    }, delay);
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ ping: 1 }).catch(() => void 0);
    }, this.pingIntervalSec * 1000);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private async restoreSubscriptions() {
    if (this.wantBalanceSub) {
      await this.send({ balance: 1, subscribe: 1 }).catch((e) =>
        log.error("re-sub balance falhou", (e as Error).message),
      );
    }
    for (const symbol of this.tickSubs) {
      await this.send({ ticks: symbol, subscribe: 1 }).catch((e) =>
        log.error(`re-sub ticks ${symbol} falhou`, (e as Error).message),
      );
    }
  }

  private onMessage(text: string) {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.req_id);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg);
    }

    switch (msg.msg_type) {
      case "tick":
        if (msg.tick)
          this.emit("tick", {
            symbol: msg.tick.symbol,
            quote: msg.tick.quote,
            epoch: msg.tick.epoch,
            pipSize: msg.tick.pip_size ?? 2,
          });
        break;
      case "balance":
        if (msg.balance) this.emit("balance", { balance: Number(msg.balance.balance), currency: msg.balance.currency });
        break;
      case "proposal_open_contract":
        if (msg.proposal_open_contract) this.emit("contract", msg.proposal_open_contract);
        break;
    }
  }

  send(payload: Record<string, unknown>, timeoutMs = 20000): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("socket nao esta aberto"));
        return;
      }
      const req_id = this.reqId++;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error(`timeout req_id=${req_id} (${Object.keys(payload)[0]})`));
      }, timeoutMs);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  // ---------- helpers de alto nivel ----------

  get accountInfo() {
    return this.account;
  }

  async subscribeTicks(symbol: string) {
    this.tickSubs.add(symbol);
    await this.send({ ticks: symbol, subscribe: 1 });
  }

  async subscribeBalance(): Promise<number> {
    this.wantBalanceSub = true;
    const res = await this.send({ balance: 1, subscribe: 1 });
    return Number(res.balance?.balance ?? this.account?.balance ?? 0);
  }

  /**
   * Horario de negociacao de um simbolo (hoje + amanha, UTC). Combina o flag ao
   * vivo `exchange_is_open` com o calendario `trading_times` (intervalos, fecho
   * antecipado de sexta, feriados).
   */
  async marketSchedule(symbol: string): Promise<{
    open: boolean;
    live: boolean;
    intervals: Array<{ open: number; close: number }>;
    note: string;
  }> {
    let live = true;
    try {
      const as = await this.send({ active_symbols: "brief" });
      const s = (as.active_symbols ?? []).find((x: any) => x.underlying_symbol === symbol);
      if (s) live = s.exchange_is_open === 1 && s.is_trading_suspended !== 1;
    } catch {
      /* usa so o calendario */
    }

    const intervals: Array<{ open: number; close: number }> = [];
    let note = "";
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    for (const dOff of [0, 1]) {
      const day = new Date(Date.now() + dOff * 86_400_000);
      const dateStr = day.toISOString().slice(0, 10);
      const dowName = DOW[day.getUTCDay()]!;
      try {
        const tt = await this.send({ trading_times: dateStr });
        let sym: any;
        for (const mk of tt.trading_times?.markets ?? [])
          for (const sm of mk.submarkets ?? [])
            for (const x of sm.symbols ?? [])
              if (x.underlying_symbol === symbol || x.symbol === symbol) sym = x;
        if (!sym || !(sym.trading_days ?? []).includes(dowName)) continue;

        const toUnix = (hms: string): number => {
          const [h, m, s] = hms.split(":").map(Number);
          return Math.floor(
            Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h ?? 0, m ?? 0, s ?? 0) / 1000,
          );
        };
        const opens: string[] = sym.times?.open ?? [];
        const closes: string[] = sym.times?.close ?? [];
        const dayIvs: Array<{ open: number; close: number }> = [];
        for (let i = 0; i < Math.min(opens.length, closes.length); i++) {
          dayIvs.push({ open: toUnix(opens[i]!), close: toUnix(closes[i]!) });
        }
        for (const ev of sym.events ?? []) {
          const forFriday = dowName === "Fri" && /friday/i.test(ev.dates ?? "");
          const forDate = new RegExp(dateStr).test(ev.dates ?? "");
          if ((forFriday || forDate) && /close|early|holiday|christmas|new year|good friday/i.test(ev.descrip ?? "")) {
            const mt = (ev.descrip ?? "").match(/(\d{1,2}):(\d{2})/);
            if (mt) {
              const early = toUnix(`${mt[1]}:${mt[2]}:00`);
              for (const iv of dayIvs) if (iv.open < early && iv.close > early) iv.close = early;
            } else if (forDate) {
              dayIvs.length = 0;
            }
            note = ev.descrip ?? note;
          }
        }
        intervals.push(...dayIvs);
      } catch {
        /* ignore este dia */
      }
    }
    intervals.sort((a, b) => a.open - b.open);
    const nowU = Math.floor(Date.now() / 1000);
    const inIv = intervals.some((iv) => nowU >= iv.open && nowU < iv.close);
    return { open: live && inIv, live, intervals, note };
  }

  /** Historico de ticks + pip_size (numero de casas decimais) do simbolo. */
  async recentTicks(symbol: string, count: number): Promise<{ prices: number[]; pipSize: number }> {
    const res = await this.send({ ticks_history: symbol, end: "latest", count, style: "ticks" });
    return {
      prices: (res.history?.prices ?? []).map(Number),
      pipSize: Number(res.pip_size ?? 2),
    };
  }

  async candles(symbol: string, count: number, granularitySec: number): Promise<number[]> {
    const res = await this.send({
      ticks_history: symbol,
      end: "latest",
      count,
      style: "candles",
      granularity: granularitySec,
    });
    return (res.candles ?? []).map((c: any) => Number(c.close));
  }

  /** Candles OHLC (para semear estrategias baseadas em candle). `end` = "latest" ou epoch string. */
  async candlesOHLC(
    symbol: string,
    count: number,
    granularitySec: number,
    end: string = "latest",
  ): Promise<{ epoch: number; open: number; high: number; low: number; close: number }[]> {
    const res = await this.send({
      ticks_history: symbol,
      end,
      count,
      style: "candles",
      granularity: granularitySec,
    });
    return (res.candles ?? []).map((c: any) => ({
      epoch: Number(c.epoch),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
    }));
  }

  /** Pede uma proposta (sem comprar) para a camada de aprendizado avaliar o payout. */
  async getProposal(opts: {
    symbol: string;
    contractType: string;
    amount: number;
    durationTicks: number;
    durationUnit?: "t" | "s" | "m";
    currency: string;
    barrier?: string;
    multiplier?: number;
    limitOrder?: { stop_loss?: number; take_profit?: number };
  }): Promise<{ id: string; askPrice: number; payout: number }> {
    const payload: Record<string, unknown> = {
      proposal: 1,
      amount: Number(opts.amount.toFixed(2)),
      basis: "stake",
      contract_type: opts.contractType,
      currency: opts.currency,
      underlying_symbol: opts.symbol,
    };
    if (opts.multiplier !== undefined) {
      // multiplicadores nao usam duracao; risco/alvo vao no limit_order (USD)
      payload.multiplier = opts.multiplier;
      if (opts.limitOrder) payload.limit_order = opts.limitOrder;
    } else {
      payload.duration = opts.durationTicks;
      payload.duration_unit = opts.durationUnit ?? "t";
      if (opts.barrier !== undefined) payload.barrier = opts.barrier;
    }
    const res = await this.send(payload);
    return {
      id: res.proposal.id as string,
      askPrice: Number(res.proposal.ask_price),
      payout: Number(res.proposal.payout ?? res.proposal.ask_price),
    };
  }

  /** Vende (fecha) um contrato aberto a mercado. */
  async sellContract(contractId: number): Promise<number> {
    const res = await this.send({ sell: contractId, price: 0 });
    return Number(res.sell?.sold_for ?? 0);
  }

  async buyProposal(id: string, maxPrice: number) {
    const buy = await this.send({ buy: id, price: Number(maxPrice.toFixed(2)) });
    return {
      contractId: Number(buy.buy.contract_id),
      buyPrice: Number(buy.buy.buy_price),
      payout: Number(buy.buy.payout),
    };
  }

  async trackContract(contractId: number) {
    await this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
  }
}
