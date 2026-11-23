// 대화 장부 (docs/dialogue-architecture.md): 인용 검증, 누가 무엇을 정리했는지, 코드 규칙으로 바뀌는 마음과 점수 이벤트.
import { describe, expect, it } from "vitest";
import { applyFacts, initialLedger, nextMind, progressEvents, resolveFacts, type Mind, type TurnFacts } from "./ledger.js";

const evaluation = { suggested_drop: 6, labels: ["empathy"], reason: "-", noticed: "-", evidence: [] };
const raw = (over: Record<string, unknown>) => ({ npcLast: [], npcResolved: [], playerNew: [], playerResolved: [], acts: [{ act: "other", quote: "기다릴게", refersTo: "" }], evaluation, ...over });

// 직전 윤재 말: 약속 하나 + (이미 장부에 있는) 한계
const prevNpc = "늦을 것 같으면 미리 한마디 할게. 대신 일할 때 바로 답하긴 어려워.";
const ctx = { playerText: "알았어 기다릴게", prevNpc, turn: 2 };

describe("인용 검증", () => {
  it("첫 시도는 원문에 없는 인용이 하나라도 있으면 다시 생성", () => {
    const bad = raw({ playerNew: [{ kind: "concern", issue: "read-gap", text: "불안했다", quote: "너무 불안했어" }] });
    expect(() => resolveFacts(initialLedger(), bad, ctx, true)).toThrow(/facts_invalid:player_quote/);
  });
  it("마지막 시도는 틀린 것만 버린다", () => {
    const bad = raw({ playerNew: [{ kind: "concern", issue: "read-gap", text: "불안했다", quote: "너무 불안했어" }] });
    expect(resolveFacts(initialLedger(), bad, ctx, false).added).toEqual([]);
  });
});

// 엔진의 적용 범위만 본다: 1차가 L1 수용을 제안하면 그 항목만 정리된다.
// "기다릴게"가 실제로 L1의 수용인지는 엔진이 단어로 정하지 않는다. 1차 프롬프트의 판단이다 (2026-11-23 결정: 기본적으로 수용이 아님)
describe("정리 범위: 1차가 제안한 항목만 정리된다", () => {
  const facts = resolveFacts(
    initialLedger(),
    raw({
      npcLast: [{ kind: "commitment", issue: "availability", text: "늦을 것 같으면 미리 한마디 하기", quote: "늦을 것 같으면 미리 한마디 할게" }],
      playerResolved: [{ id: "L1", status: "accepted", quote: "기다릴게" }],
      acts: [{ act: "accept", quote: "기다릴게", refersTo: "L1" }],
    }),
    ctx,
    true,
  );
  const ledger = applyFacts(initialLedger(), facts, 2);

  it("윤재의 한계(L1)는 받아들여지고, 직전에 한 약속(L4)은 열린 채 남는다", () => {
    expect(ledger.find((x) => x.id === "L1")).toMatchObject({ status: "accepted", resolvedBy: { by: "player", turn: 2, quote: "기다릴게" } });
    expect(ledger.find((x) => x.id === "L4")).toMatchObject({ by: "npc", kind: "commitment", status: "open", turn: 1 });
  });
  it("같은 사실을 다시 적용해도 장부가 같다 (저장된 기록으로 따라잡기)", () => {
    expect(applyFacts(initialLedger(), facts, 2)).toEqual(ledger);
  });
  it("이번에 새로 생긴 윤재 항목도 N번호로 바로 받아들일 수 있다", () => {
    const f = resolveFacts(
      initialLedger(),
      raw({
        npcLast: [{ kind: "commitment", issue: "availability", text: "늦을 것 같으면 미리 한마디 하기", quote: "미리 한마디 할게" }],
        playerResolved: [{ id: "N1", status: "accepted", quote: "기다릴게" }],
      }),
      ctx,
      true,
    );
    expect(f.resolved).toEqual([{ id: "L4", by: "player", status: "accepted", quote: "기다릴게" }]);
  });
});

describe("누가 정리할 수 있나", () => {
  it("플레이어는 자기 항목을 받아들일 수 없고, 연인의 항목을 거둬들일 수 없다", () => {
    expect(() => resolveFacts(initialLedger(), raw({ playerResolved: [{ id: "L3", status: "accepted", quote: "기다릴게" }] }), ctx, true)).toThrow(/bad_status/);
    expect(() => resolveFacts(initialLedger(), raw({ playerResolved: [{ id: "L1", status: "closed", quote: "기다릴게" }] }), ctx, true)).toThrow(/bad_status/);
  });
  it("없는 항목이나 이미 정리된 항목은 정리할 수 없다", () => {
    expect(() => resolveFacts(initialLedger(), raw({ playerResolved: [{ id: "L9", status: "accepted", quote: "기다릴게" }] }), ctx, true)).toThrow(/bad_id/);
  });
  it("첫 마디에는 직전 연인 말(오프닝)을 다시 기록하지 않는다", () => {
    const f = resolveFacts(initialLedger(), raw({ npcLast: [{ kind: "limit", issue: "availability", text: "x", quote: "일할 땐" }] }), { playerText: "기다릴게", prevNpc: "일할 땐 오늘처럼 답 늦을 때도 있어", turn: 1 }, true);
    expect(f.added).toEqual([]);
  });
});

describe("마음은 코드 규칙으로만 바뀐다", () => {
  const mind: Mind = { fatigue: 3, guilt: 1, defensiveness: 2, care: 2, openness: 1 };
  const f = (acts: TurnFacts["acts"], resolved: TurnFacts["resolved"] = []): TurnFacts => ({ v: 2, added: [], resolved, acts, evaluation });

  it("비난·단정 → 방어심↑ 열림↓ (평가도 pressure일 때만), 상대 생각을 물음 → 방어심↓ 열림↑", () => {
    const accuse = f([{ act: "accuse", quote: "x", refersTo: "" }]);
    expect(nextMind(mind, accuse, initialLedger(), null)).toMatchObject({ defensiveness: 2, openness: 1 });
    expect(nextMind(mind, { ...accuse, evaluation: { ...evaluation, labels: ["pressure"] } }, initialLedger(), null)).toMatchObject({ defensiveness: 3, openness: 0 });
    expect(nextMind(mind, f([{ act: "question", quote: "x", refersTo: "" }]), initialLedger(), null)).toMatchObject({ defensiveness: 1, openness: 2 });
  });
  it("한 턴에 축마다 한 단계까지만, 피곤함은 그대로", () => {
    const m = nextMind(mind, f([{ act: "question", quote: "x", refersTo: "" }, { act: "apology", quote: "y", refersTo: "L2" }], [{ id: "L1", by: "player", status: "accepted", quote: "z" }]), initialLedger(), null);
    expect(m.defensiveness).toBe(1);
    expect(m.fatigue).toBe(3);
  });
  it("연인의 걱정이 열려 있는데 아무것도 짚지 않은 사과를 반복하면 방어심이 오른다", () => {
    const bare = f([{ act: "apology", quote: "미안해", refersTo: "" }]);
    expect(nextMind(mind, bare, initialLedger(), null).defensiveness).toBe(2);
    expect(nextMind(mind, bare, initialLedger(), bare).defensiveness).toBe(3);
    // 연인의 걱정(L2)을 짚은 사과는 방어심을 낮춘다
    expect(nextMind(mind, f([{ act: "apology", quote: "무시했다고 해서 미안", refersTo: "L2" }]), initialLedger(), bare).defensiveness).toBe(1);
  });
});

describe("점수 이벤트는 장부 변경에서 나온다", () => {
  it("연인의 한계를 받아들임 · 자기 행동 약속 · 방법 제안", () => {
    const facts: TurnFacts = {
      v: 2,
      added: [
        { id: "L4", by: "player", kind: "commitment", issue: "intent-trust", text: "무시라고 단정하지 않기", quote: "단정하지 않을게", turn: 2, status: "open" },
        { id: "L5", by: "player", kind: "proposal", issue: "repair-method", text: "늦으면 이유 먼저 말하기", quote: "이유 먼저", turn: 2, status: "open" },
      ],
      resolved: [{ id: "L1", by: "player", status: "accepted", quote: "바로 못 볼 수 있지" }],
      acts: [{ act: "accept", quote: "바로 못 볼 수 있지", refersTo: "L1" }],
      evaluation,
    };
    const ledger = applyFacts(initialLedger(), facts, 2);
    expect(progressEvents(facts, ledger, false).map((e) => e.type)).toEqual(["player_accepts_limit", "player_changes_approach", "proposal_created"]);
  });
  it("연인이 플레이어의 걱정을 받아들이면 acknowledged", () => {
    const facts: TurnFacts = { v: 2, added: [], resolved: [{ id: "L3", by: "npc", status: "accepted", quote: "미안" }], acts: [{ act: "other", quote: "x", refersTo: "" }], evaluation };
    expect(progressEvents(facts, applyFacts(initialLedger(), facts, 2), false)).toEqual([{ type: "acknowledged", issue: "read-gap" }]);
  });
});
