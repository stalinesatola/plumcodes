#!/usr/bin/env python3
"""
Sidecar de aprendizado online para o plumcodes Deriv Multi-Bot.

Protocolo: uma linha JSON por mensagem em stdin, uma linha JSON por resposta em stdout.

  -> {"type":"predict","id":<int>,"key":"<botId|tag>","features":[float,...]}
  <- {"type":"prediction","id":<int>,"pWin":<float 0..1>,"n":<int>}

  -> {"type":"observe","key":"<botId|tag>","features":[float,...],"win":0|1}
  <- {"type":"ack","key":"...","n":<int>}

Modelo: regressao logistica com SGD + padronizacao online (media/desvio correntes),
um modelo por 'key'. Pesos persistidos em ml/model.json a cada N observacoes.
Sem dependencias externas (so stdlib).
"""
import sys
import json
import math
import os

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model.json")
LR = 0.05
L2 = 1e-4
SAVE_EVERY = 20


class OnlineLogReg:
    def __init__(self, dim):
        self.dim = dim
        self.w = [0.0] * dim
        self.b = 0.0
        self.mean = [0.0] * dim
        self.var = [1.0] * dim
        self.n = 0

    def _standardize(self, x):
        out = []
        for i in range(self.dim):
            sd = math.sqrt(self.var[i]) if self.var[i] > 1e-9 else 1.0
            out.append((x[i] - self.mean[i]) / sd)
        return out

    def _update_norm(self, x):
        self.n += 1
        a = 1.0 / min(self.n, 500)  # janela efetiva ~500
        for i in range(self.dim):
            d = x[i] - self.mean[i]
            self.mean[i] += a * d
            self.var[i] = (1 - a) * (self.var[i] + a * d * d)

    def predict(self, x):
        if len(x) != self.dim:
            x = (x + [0.0] * self.dim)[: self.dim]
        z = self._standardize(x)
        s = self.b + sum(self.w[i] * z[i] for i in range(self.dim))
        s = max(-30.0, min(30.0, s))
        return 1.0 / (1.0 + math.exp(-s))

    def learn(self, x, y):
        if len(x) != self.dim:
            x = (x + [0.0] * self.dim)[: self.dim]
        self._update_norm(x)
        z = self._standardize(x)
        p = self.predict(x)
        g = p - y
        for i in range(self.dim):
            self.w[i] -= LR * (g * z[i] + L2 * self.w[i])
        self.b -= LR * g

    def to_dict(self):
        return {"dim": self.dim, "w": self.w, "b": self.b, "mean": self.mean, "var": self.var, "n": self.n}

    @classmethod
    def from_dict(cls, d):
        m = cls(d["dim"])
        m.w, m.b, m.mean, m.var, m.n = d["w"], d["b"], d["mean"], d["var"], d["n"]
        return m


MODELS = {}
_since_save = 0


def load():
    global MODELS
    try:
        with open(MODEL_PATH) as f:
            raw = json.load(f)
        MODELS = {k: OnlineLogReg.from_dict(v) for k, v in raw.items()}
    except Exception:
        MODELS = {}


def save():
    try:
        with open(MODEL_PATH, "w") as f:
            json.dump({k: m.to_dict() for k, m in MODELS.items()}, f)
    except Exception as e:
        sys.stderr.write(f"save failed: {e}\n")


def get_model(key, dim):
    m = MODELS.get(key)
    if m is None or m.dim != dim:
        m = OnlineLogReg(dim)
        MODELS[key] = m
    return m


def main():
    global _since_save
    load()
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        t = msg.get("type")
        if t == "predict":
            feats = msg.get("features", [])
            m = get_model(msg.get("key", "_"), len(feats) or 1)
            p = m.predict(feats) if feats else 0.5
            out.write(json.dumps({"type": "prediction", "id": msg.get("id"), "pWin": p, "n": m.n}) + "\n")
            out.flush()
        elif t == "observe":
            feats = msg.get("features", [])
            key = msg.get("key", "_")
            m = get_model(key, len(feats) or 1)
            m.learn(feats, int(msg.get("win", 0)))
            _since_save += 1
            if _since_save >= SAVE_EVERY:
                save()
                _since_save = 0
            out.write(json.dumps({"type": "ack", "key": key, "n": m.n}) + "\n")
            out.flush()
        elif t == "ping":
            out.write(json.dumps({"type": "pong"}) + "\n")
            out.flush()
    save()


if __name__ == "__main__":
    main()
