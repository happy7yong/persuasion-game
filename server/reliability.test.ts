// relationship-engine에서 가져온 실패·멱등 규칙이 지켜지는지 확인한다.
import { describe, expect, it } from "vitest";
import { callWithRetry } from "./llm.js";
import { FUNCTION_MAX_DURATION_MS, modelConfig, type CallModelConfig } from "./model-config.js";
import { parseNpcOutput } from "./npc.js";
import { newGame, recordTurn } from "./rules.js";
import type { StoredTurn } from "./store.js";
import { catchUp } from "./sync.js";
import { decodeState, encodeState } from "./token.js";

const cfg: CallModelConfig = { ...modelConfig("npc_turn"), timeoutMs: 50, budgetMs: 1000 };
const call = { system: "s", user: "u", schemaName: "t", schema: {} };
const okBody = (content: string) =>
  new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, cost: 0.001 } }));
const goodNpc = JSON.stringify({ beats: [{ type: "dialogue", content: "응" }], evaluation: { suggested_drop: 5, labels: ["emotion"], reason: "r" } });

describe("시간 예산", () => {
  it("재시도까지 포함한 예산이 함수 상한 안에 들어간다", () => {
    for (const t of ["npc_turn", "belief"] as const) {
      const c = modelConfig(t);
      expect(c.timeoutMs * c.maxAttempts).toBeLessThanOrEqual(c.budgetMs);
      expect(c.budgetMs).toBeLessThan(FUNCTION_MAX_DURATION_MS);
    }
  });
});

describe("LLM 호출 재시도", () => {
  it("형식이 틀리면 한 번 더 시도하고, 두 시도를 모두 기록한다", async () => {
    let n = 0;
    const fetchImpl = (async () => okBody(n++ === 0 ? "{\"beats\":[]}" : goodNpc)) as typeof fetch;
    const r = await callWithRetry(cfg, call, (j) => parseNpcOutput(j), fetchImpl);
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0]?.result).toMatch(/^invalid_output/);
    expect(r.attempts[1]?.result).toBe("ok");
  });

  it("두 번 다 실패하면 실패를 돌려주고 대체 대사를 만들지 않는다", async () => {
    const fetchImpl = (async () => new Response("busy", { status: 503 })) as typeof fetch;
    const r = await callWithRetry(cfg, call, (j) => parseNpcOutput(j), fetchImpl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("http");
    expect(r.attempts).toHaveLength(2);
  });

  it("시도마다 하드 타임아웃이 걸린다", async () => {
    const fetchImpl = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await callWithRetry(cfg, call, (j) => parseNpcOutput(j), fetchImpl);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("남은 예산이 부족하면 두 번째 시도를 시작하지 않는다", async () => {
    let clock = 0;
    const fetchImpl = (async () => {
      clock += 990;
      return new Response("x", { status: 500 });
    }) as typeof fetch;
    const r = await callWithRetry(cfg, call, (j) => parseNpcOutput(j), fetchImpl, () => clock);
    expect(r.attempts).toHaveLength(1);
  });

  it("기록에 API 키가 남지 않는다", async () => {
    process.env.OPENROUTER_API_KEY = "sk-secret-test";
    const fetchImpl = (async () => okBody(goodNpc)) as typeof fetch;
    const r = await callWithRetry(cfg, call, (j) => parseNpcOutput(j), fetchImpl);
    expect(JSON.stringify(r.attempts)).not.toContain("sk-secret-test");
    delete process.env.OPENROUTER_API_KEY;
  });
});

describe("저장된 기록으로 따라잡기 (멱등)", () => {
  const row = (idx: number, key: string, text: string): StoredTurn => ({
    idx,
    idempotency_key: key,
    player_text: text,
    npc_beats: [{ type: "dialogue", content: "응" }],
    npc_move: "counter",
    suggested_drop: 10,
    labels: ["emotion"],
  });

  it("응답을 못 받은 마디를 옛 토큰 위에 다시 적용한다", () => {
    const s0 = newGame("p", Date.now(), false);
    const { latest, extra } = catchUp(s0, [row(1, "a", "첫 말"), row(2, "b", "둘째 말")]);
    expect(extra.map((r) => r.idempotency_key)).toEqual(["a", "b"]);
    expect(latest.turns).toHaveLength(2);
    expect(latest.score).toBe(80);
  });

  it("이미 토큰에 있는 마디는 다시 적용하지 않는다", () => {
    const s1 = recordTurn(newGame("p", Date.now(), false), { player: "첫 말", npc: [], suggested: 10, labels: ["emotion"] });
    const { latest, extra } = catchUp(s1, [row(1, "a", "첫 말")]);
    expect(extra).toHaveLength(0);
    expect(latest).toBe(s1);
  });
});

describe("토큰 암호화", () => {
  it("클라이언트가 숨긴 점수를 읽을 수 없다", () => {
    const s = recordTurn(newGame("p", Date.now(), false), { player: "비밀스러운 말", npc: [], suggested: 13, labels: ["emotion"] });
    const token = encodeState(s);
    const visible = token
      .split(".")
      .map((p) => {
        try {
          return Buffer.from(p, "base64url").toString("utf8");
        } catch {
          return "";
        }
      })
      .join(" ");
    expect(visible).not.toContain("score");
    expect(visible).not.toContain("비밀스러운");
    expect(decodeState(token)?.score).toBe(87);
  });
});
