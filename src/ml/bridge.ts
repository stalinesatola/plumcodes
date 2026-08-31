import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { AppConfig } from "../types.ts";
import { createLogger } from "../util/logger.ts";

const log = createLogger("ml");

/**
 * Ponte para o sidecar Python (ml/predictor.py) — aprendizado online em outra
 * linguagem. Se o Python nao existir ou o processo cair, degrada de forma limpa:
 * predict() retorna null e o bot ignora o gate de ML.
 */
export class MlBridge {
  private cfg: AppConfig["ml"];
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, (p: number | null) => void>();
  private ready = false;
  private restarts = 0;

  constructor(cfg: AppConfig) {
    this.cfg = cfg.ml;
  }

  start() {
    if (!this.cfg.enabled) {
      log.info("ML desativado no config");
      return;
    }
    this.spawn();
  }

  private spawn() {
    try {
      const p = spawn(this.cfg.pythonPath, [this.cfg.scriptPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = p;
      this.ready = true;
      log.info(`sidecar iniciado: ${this.cfg.pythonPath} ${this.cfg.scriptPath}`);

      const rl = createInterface({ input: p.stdout });
      rl.on("line", (line) => this.onLine(line));
      p.stderr.on("data", (d) => log.warn("py:", String(d).trim()));

      p.on("exit", (code) => {
        this.ready = false;
        this.proc = null;
        for (const [, res] of this.pending) res(null);
        this.pending.clear();
        log.warn(`sidecar saiu code=${code}`);
        if (this.cfg.enabled && this.restarts < 10) {
          this.restarts++;
          setTimeout(() => this.spawn(), 3000);
        }
      });
      p.on("error", (e) => {
        this.ready = false;
        log.error("nao foi possivel iniciar o Python", (e as Error).message);
      });
    } catch (e) {
      log.error("spawn falhou", (e as Error).message);
    }
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "prediction" && this.pending.has(msg.id)) {
      const res = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      res(typeof msg.pWin === "number" ? msg.pWin : null);
    }
  }

  /** Probabilidade estimada de vitoria (0..1) ou null se indisponivel. */
  predict(key: string, features: number[], timeoutMs = 1500): Promise<number | null> {
    if (!this.ready || !this.proc) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, (p) => {
        clearTimeout(timer);
        resolve(p);
      });
      this.proc!.stdin.write(JSON.stringify({ type: "predict", id, key, features }) + "\n");
    });
  }

  /** Ensina o modelo com o resultado real. */
  observe(key: string, features: number[], win: boolean) {
    if (!this.ready || !this.proc) return;
    this.proc.stdin.write(
      JSON.stringify({ type: "observe", key, features, win: win ? 1 : 0 }) + "\n",
    );
  }

  get minEdge() {
    return this.cfg.minEdge;
  }
  get enabled() {
    return this.cfg.enabled && this.ready;
  }

  stop() {
    this.cfg = { ...this.cfg, enabled: false };
    this.proc?.stdin.end();
    this.proc?.kill();
  }
}
