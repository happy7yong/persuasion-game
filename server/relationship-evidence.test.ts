import { describe, expect, it } from "vitest";
import { newGame, recordTurn, relationshipEvidence, type GameState } from "./rules.js";
import type { TurnFacts } from "./ledger.js";
import { decodeState, encodeState } from "./token.js";

const evaluation = { suggested_drop: 8, labels: ["emotion"], reason: "-", noticed: "-", evidence: [] };
const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({ v: 2, added: [], resolved: [], acts: [{ act: "other", quote: "응", refersTo: "" }], evaluation, ...over });
const concern = { id: "L4", by: "player" as const, kind: "concern" as const, issue: "read-gap" as const,
  text: "읽은 뒤 답이 없어 혼자 남은 느낌이었다", quote: "읽힌 뒤 아무 소식이 없으니", turn: 1, status: "open" as const };
const player = "15:32에 읽힌 뒤 아무 소식이 없으니 불안했고 혼자 남은 것 같았어.";
const add = (state: GameState, message: string, frame: TurnFacts, reply: string): GameState => recordTurn(state, {
  player: message, npc: [{ type: "dialogue", content: reply }], facts: frame, suggested: 8, labels: ["emotion"],
});

describe("대화 전체의 서운함 근거", () => {
  it("시작 카톡과 사과만으로 플레이어의 감정 표현이 기록되지 않는다", () => {
    const state = add(newGame("sorry", 0, false), "미안해. 내가 너무 재촉했어.", facts({
      acts: [{ act: "apology", quote: "미안해", refersTo: "L2" }],
      responseRefs: [{ id: "L3", use: "reflect" }],
    }), "기다리게 해서 미안해.");
    expect(relationshipEvidence(state)).toEqual({ player: null, npc: null });
  });

  it("이번 판에 계기와 감정을 직접 말하면 근거를 남기고, 윤재가 답한 뒤 연결한다", () => {
    const first = add(newGame("mutual", Date.now(), false), player, facts({
      added: [concern], acts: [{ act: "feeling", quote: "불안했고", refersTo: "L4" }],
    }), "네가 혼자 남은 것처럼 느낀 건 이해해.");
    expect(relationshipEvidence(first)).toEqual({
      player: { turn: 1, itemId: "L4", quote: concern.quote, message: player }, npc: null,
    });
    expect(first.relationshipEvidence).toEqual(relationshipEvidence(first));
    const second = add(first, "응, 그건 이해해.", facts({
      resolved: [{ id: "L4", by: "npc", status: "accepted", quote: "네가 혼자 남은 것 같았겠네" }],
    }), "네가 혼자 남은 것 같았겠네.");
    expect(relationshipEvidence(second).npc).toEqual({ turn: 1, itemId: "L4", quote: "네가 혼자 남은 것 같았겠네" });
    expect(relationshipEvidence(decodeState(encodeState(second))!)).toEqual(relationshipEvidence(second));
    expect(second.relationshipEvidence).toEqual(relationshipEvidence(second));
  });

  it("마지막 마디의 답변도 같은 장부 항목을 짚으면 즉시 기록된다", () => {
    let state = newGame("final", 0, false);
    for (let i = 0; i < 4; i++) state = add(state, "응.", facts(), "응.");
    const finalConcern = { ...concern, id: "L5", turn: 5 };
    state = add(state, player, facts({
      added: [finalConcern], acts: [{ act: "feeling", quote: "불안했고", refersTo: "L5" }],
      responseRefs: [{ id: "L5", use: "reflect" }],
    }), "읽고도 답이 없어서 혼자 남은 것 같았구나. 그건 미안해.");
    expect(relationshipEvidence(state).npc).toEqual({ turn: 5, itemId: "L5", quote: "읽고도 답이 없어서 혼자 남은 것 같았구나. 그건 미안해." });
  });

  it("응답 참조가 있어도 감정에 대한 실제 대사가 없으면 기록하지 않는다", () => {
    const state = add(newGame("empty-ref", 0, false), player, facts({
      added: [concern], acts: [{ act: "feeling", quote: "불안했고", refersTo: "L4" }],
      responseRefs: [{ id: "L4", use: "reflect" }],
    }), "응, 알겠어.");
    expect(relationshipEvidence(state).player?.itemId).toBe("L4");
    expect(relationshipEvidence(state).npc).toBeNull();
  });
});
