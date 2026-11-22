// 장부 상태가 다음 마디로 실제로 이어지는지: 토큰(주 경로)과 DB 따라잡기(state_frame, 보조 경로) 둘 다.
import { describe, expect, it } from "vitest";
import type { TurnFacts } from "./ledger.js";
import { buildNpcPrompt } from "./npc.js";
import { newGame, recordTurn, type GameState } from "./rules.js";
import type { StoredTurn } from "./store.js";
import { catchUp } from "./sync.js";
import { decodeState, encodeState } from "./token.js";

const evaluation = { suggested_drop: 8, labels: ["empathy"], reason: "근거", noticed: "알게 된 것", evidence: ["단정하지 않을게"] };
// 1마디: 플레이어가 윤재의 한계(L1)를 받아들이고, 자기 행동을 약속한다
const turn1: TurnFacts = {
  v: 2,
  added: [{ id: "L4", by: "player", kind: "commitment", issue: "intent-trust", text: "플레이어가 무시라고 단정하지 않겠다", quote: "단정하지 않을게", turn: 1, status: "open" }],
  resolved: [{ id: "L1", by: "player", status: "accepted", quote: "바로 못 볼 수 있지" }],
  acts: [{ act: "accept", quote: "바로 못 볼 수 있지", refersTo: "L1" }, { act: "promise", quote: "단정하지 않을게", refersTo: "" }],
  evaluation,
};
const turn = (player: string, facts: TurnFacts) => ({ player, npc: [{ type: "dialogue" as const, content: "그래, 그건 고마워." }], move: "counter" as const, facts, thought: "조금 풀렸다", noticed: "단정을 거둠", suggested: facts.evaluation.suggested_drop, labels: ["empathy" as const] });
// api/turn.ts가 저장하는 모양 그대로
const stored = (idx: number, t: ReturnType<typeof turn>): StoredTurn => ({ idx, idempotency_key: `k${idx}`, player_text: t.player, npc_beats: t.npc, npc_move: t.move, reason: t.thought, noticed: t.noticed, suggested_drop: t.suggested, labels: t.labels, state_frame: JSON.parse(JSON.stringify(t.facts)) });

describe("장부 상태 저장·복원", () => {
  const t1 = turn("일할 땐 바로 못 볼 수 있지. 단정하지 않을게", turn1);
  const live = recordTurn(newGame("persist", Date.now(), false), t1);

  it("주 경로: 토큰을 거쳐도 장부·마음·점수 이벤트가 그대로다", () => {
    const back = decodeState(encodeState(live))!;
    expect(back.ledger).toEqual(live.ledger);
    expect(back.currentMind).toEqual(live.currentMind);
    expect(back.progress).toEqual(live.progress);
    expect(back.ledger.find((x) => x.id === "L1")?.status).toBe("accepted");
  });

  it("보조 경로: 옛 토큰으로 와도 DB의 state_frame으로 같은 상태를 다시 쌓는다", () => {
    const { latest } = catchUp(newGame("persist", live.startedAt, false), [stored(1, t1)]);
    expect(latest.ledger).toEqual(live.ledger);
    expect(latest.currentMind).toEqual(live.currentMind);
    expect(latest.progress).toEqual(live.progress);
    expect(latest.score).toBe(live.score);
  });

  it("state_frame이 없던 예전 기록은 장부를 바꾸지 않고 점수만 예전 방식으로 계산한다", () => {
    const { latest } = catchUp(newGame("persist", live.startedAt, false), [{ ...stored(1, t1), state_frame: null }]);
    expect(latest.ledger.find((x) => x.id === "L1")?.status).toBe("open");
    expect(latest.turns[0]?.scoreBreakdown?.kind).toBe("legacy");
  });

  it("복원한 상태로 만든 2마디 대사 프롬프트에 1마디의 정리 내용과 마음이 들어간다", () => {
    const { latest } = catchUp(newGame("persist", live.startedAt, false), [stored(1, t1)]);
    const p = buildNpcPrompt(latest, "응 알겠어");
    expect(p.system).toContain("L1 [너 · 한계 · availability · 받아들여짐, 플레이어가 1마디에 “바로 못 볼 수 있지”]");
    expect(p.system).toContain("L4 [플레이어 · 약속");
    expect(p.system).toContain(`방어심 ${live.currentMind.defensiveness}`);
  });

  it("다섯 마디를 채워도 토큰이 상한(64,000자)보다 충분히 작다", () => {
    let s: GameState = newGame("size", Date.now(), false);
    const long = "가".repeat(120);
    for (let i = 1; i <= 5; i++) {
      const facts: TurnFacts = {
        ...turn1,
        added: [0, 1, 2].map((k) => ({ id: `L${s.ledger.length + 1 + k}`, by: "player" as const, kind: "request" as const, issue: "repair-method" as const, text: long, quote: long.slice(0, 25), turn: i, status: "open" as const })),
        resolved: [],
        evaluation: { ...evaluation, reason: long, evidence: [long, long] },
      };
      s = recordTurn(s, { ...turn(long + long, facts), npc: [{ type: "dialogue", content: long }, { type: "narration", content: long }], thought: long });
    }
    const size = encodeState(s).length;
    expect(size).toBeLessThan(20_000);
    expect(decodeState(encodeState(s))?.ledger).toEqual(s.ledger);
  });

  it("압축 전(v2)에 시작한 판의 토큰도 읽는다", async () => {
    const { createCipheriv, createHash, randomBytes } = await import("node:crypto");
    const k = createHash("sha256").update(`persuasion-game/token/v2:${process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16 ? process.env.SESSION_SECRET : "dev-only-secret-change-me"}`).digest();
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", k, iv);
    const body = Buffer.concat([c.update(JSON.stringify(live), "utf8"), c.final()]);
    const v2 = ["v2", iv.toString("base64url"), body.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
    expect(decodeState(v2)?.ledger).toEqual(live.ledger);
  });
});
