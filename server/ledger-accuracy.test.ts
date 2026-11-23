// 1단계(1차의 책임 구분과 장부 정확도, docs/appraisal-review.md §10~§12)의 회귀 테스트. 유료 호출 없음.
// - A: 검증에서 버린 것과 이유를 dropped로 남긴다. dropped는 진단 정보일 뿐, 장부·마음·점수·대사 프롬프트에 쓰지 않는다.
// - B: 1차 프롬프트는 "말로 분명히 드러낸 정리만" 기록하게 하고, 애매하면 refersTo로 연결만 하게 한다.
import { describe, expect, it } from "vitest";
import { reassertViolation } from "./checks.js";
import { applyFacts, factsLines, initialLedger, ledgerLines, nextMind, progressEvents, resolveFacts, type TurnFacts } from "./ledger.js";
import { buildFactsPrompt, buildNpcPrompt, parseFacts } from "./npc.js";
import { newGame, recordTurn } from "./rules.js";
import { decodeState, encodeState } from "./token.js";

const evaluation = { suggested_drop: 6, labels: ["empathy"], reason: "-", noticed: "-", evidence: [] };
const raw = (over: Record<string, unknown>) => ({ npcLast: [], npcResolved: [], playerNew: [], playerResolved: [], acts: [{ act: "other", quote: "기다릴게", refersTo: "" }], evaluation, ...over });
const prevNpc = "늦을 것 같으면 미리 한마디 할게. 대신 일할 때 바로 답하긴 어려워.";
const ctx = { playerText: "알았어 기다릴게", prevNpc, turn: 2 };

describe("A. 버린 기록 (진단용)", () => {
  it("인용이 원문에 없는 항목은 버리고, 무엇을 왜 버렸는지 남긴다. 올바른 항목은 그대로 확정한다", () => {
    const f = resolveFacts(
      initialLedger(),
      raw({
        npcLast: [{ kind: "commitment", issue: "availability", text: "늦으면 미리 말하기", quote: "미리 한마디 할게" }],
        playerNew: [{ kind: "concern", issue: "read-gap", text: "불안했다", quote: "너무 불안했어" }],
      }),
      ctx,
      false,
    );
    expect(f.added.map((x) => x.quote)).toEqual(["미리 한마디 할게"]);
    expect(f.dropped).toEqual([`player_quote: concern "불안했다" / 인용 "너무 불안했어"`]);
  });

  it("없는 항목과 이미 정리된 항목을 구분해 남긴다", () => {
    const ledger = applyFacts(initialLedger(), { v: 2, added: [], resolved: [{ id: "L1", by: "player", status: "accepted", quote: "기다릴게" }], acts: [{ act: "other", quote: "x", refersTo: "" }], evaluation }, 1);
    const f = resolveFacts(ledger, raw({ playerResolved: [{ id: "L9", status: "accepted", quote: "기다릴게" }, { id: "L1", status: "accepted", quote: "기다릴게" }] }), ctx, false);
    expect(f.resolved).toEqual([]);
    expect(f.dropped?.[0]).toMatch(/^bad_id: player L9/);
    expect(f.dropped?.[1]).toMatch(/^not_open: player L1 accepted \(이미 accepted\)/);
  });

  it("틀리지 않았지만 반영하지 않은 것(없는 연결·첫 마디의 npcLast)도 남기되, 첫 시도를 거부하지는 않는다", () => {
    const f = resolveFacts(
      initialLedger(),
      raw({ npcLast: [{ kind: "limit", issue: "availability", text: "x", quote: "일할 땐" }], acts: [{ act: "accept", quote: "기다릴게", refersTo: "L9" }] }),
      { playerText: "기다릴게", prevNpc: "일할 땐 오늘처럼 답 늦을 때도 있어", turn: 1 },
      true,
    );
    expect(f.acts[0]?.refersTo).toBe("");
    expect(f.dropped).toEqual([`npc_first_turn: limit "x" / 인용 "일할 땐"`, "bad_ref: accept → L9 (연결만 지움)"]);
  });

  it("버린 게 없으면 dropped 필드 자체가 없다 (예전 기록과 같은 모양)", () => {
    const f = resolveFacts(initialLedger(), raw({ acts: [{ act: "promise", quote: "기다릴게", refersTo: "L1" }] }), ctx, true);
    expect("dropped" in f).toBe(false);
  });

  it("parseFacts(대사 호출 경로)를 거쳐도 dropped가 남는다", () => {
    const s = newGame("pf", Date.now(), false);
    const f = parseFacts(s, "알았어 기다릴게", raw({ playerNew: [{ kind: "concern", issue: "read-gap", text: "불안했다", quote: "없는 말" }] }), false);
    expect(f.dropped?.[0]).toMatch(/^player_quote:/);
  });
});

describe("A. dropped는 사실로 쓰지 않는다", () => {
  const base: TurnFacts = {
    v: 2,
    added: [],
    resolved: [{ id: "L1", by: "player", status: "accepted", quote: "기다릴게" }],
    acts: [{ act: "accept", quote: "기다릴게", refersTo: "L1" }],
    evaluation,
  };
  const withDropped: TurnFacts = { ...base, dropped: [`player_quote: concern "지어낸 걱정" / 인용 "없는 말"`, "bad_id: player L9 accepted / 인용 \"기다릴게\""] };
  const mind = { fatigue: 3, guilt: 1, defensiveness: 3, care: 2, openness: 1 } as const;

  it("장부·마음·점수 이벤트가 dropped와 무관하다", () => {
    const a = applyFacts(initialLedger(), base, 2);
    const b = applyFacts(initialLedger(), withDropped, 2);
    expect(b).toEqual(a);
    expect(nextMind(mind, withDropped, b, null)).toEqual(nextMind(mind, base, a, null));
    expect(progressEvents(withDropped, b, true)).toEqual(progressEvents(base, a, true));
  });

  it("대사 프롬프트에 버린 내용이 들어가지 않는다", () => {
    const s = newGame("dp", Date.now(), false);
    const p = buildNpcPrompt(s, "알았어 기다릴게", "counter", withDropped);
    expect(p.system).toEqual(buildNpcPrompt(s, "알았어 기다릴게", "counter", base).system);
    expect(p.system).not.toContain("지어낸 걱정");
    expect(factsLines(withDropped, b(withDropped))).toEqual(factsLines(base, b(base)));
  });

  it("dropped가 있는 기록도 토큰을 거쳐 같은 상태로 돌아오고, 점수는 dropped가 없을 때와 같다", () => {
    const turn = (facts: TurnFacts) => ({ player: "알았어 기다릴게", npc: [{ type: "dialogue" as const, content: "응." }], move: "counter" as const, facts, suggested: 6, labels: ["empathy" as const] });
    const now = Date.now();
    const s1 = recordTurn(newGame("tk", now, false), turn(base));
    const s2 = recordTurn(newGame("tk", now, false), turn(withDropped));
    expect(s2.score).toBe(s1.score);
    expect(s2.ledger).toEqual(s1.ledger);
    expect(decodeState(encodeState(s2))!.turns[0]?.facts).toEqual(withDropped);
  });

  function b(f: TurnFacts) {
    return applyFacts(initialLedger(), f, 2);
  }
});

describe("B. 1차 프롬프트의 정리 기준", () => {
  const s = newGame("fp", Date.now(), false);
  const p = buildFactsPrompt(s, "알았어 기다릴게").system;

  it("말로 분명히 드러낸 정리만 기록하고, 애매하면 연결만 한다", () => {
    expect(p).toContain("# 정리(받아들임·거절·거둬들임)의 기준");
    expect(p).toContain("말로 분명히 드러낸 경우만");
    expect(p).toContain("특정 단어가 있는지로 정하지 않는다");
    expect(p).toContain("refersTo로 그 항목에 **연결만** 한다");
    expect(p).toContain("속으로 납득했는지");
  });

  it("열린 항목을 '아직 받아들인다고 말하지 않은 것'으로 설명한다 (다시 설명해야 할 입장으로 쓰지 않는다)", () => {
    expect(p).toContain("아직 받아들인다고 말하지 않았다");
    expect(p).not.toContain("아직 지키는 입장은 장부의 열린 NPC 항목이다");
  });

  it("accept를 단어로 정의하지 않는다", () => {
    expect(p).not.toContain('accept(상대 항목의 내용을 받아들임: "알겠어"');
  });
});

describe("V2는 그대로: 말로 정리된 항목만 막고, 열린 항목은 막지 않는다", () => {
  it("열린 항목(수용이 확정되지 않음)을 다시 말해도 V2가 거부하지 않는다", () => {
    expect(reassertViolation(initialLedger(), [{ id: "L1", use: "assert" }])).toBeNull();
  });
  it("말로 받아들여진 항목을 다시 내세우면 지금처럼 거부한다", () => {
    const ledger = applyFacts(initialLedger(), { v: 2, added: [], resolved: [{ id: "L1", by: "player", status: "accepted", quote: "이해해" }], acts: [{ act: "accept", quote: "이해해", refersTo: "L1" }], evaluation }, 1);
    expect(reassertViolation(ledger, [{ id: "L1", use: "assert" }])).toBe("reasserts_resolved:L1");
    expect(ledgerLines(ledger, "npc")).toContain("받아들여짐");
  });
});
