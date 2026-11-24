// 전체 대화 피드백: 실제 내 말·속마음을 근거로 쓰고, 지어낸 인용과 진단 라벨은 막는다.
import { describe, expect, it } from "vitest";
import { buildBeliefPrompt, isCurrentBelief, parseBelief, quoteIsReal, thoughtQuoteIsReal, writeBelief } from "./belief.js";
import { buildNpcPrompt, parseNpcOutput } from "./npc.js";
import { newGame, recordTurn, type GameState } from "./rules.js";

const game = (partner: "m" | "f" = "m"): GameState => {
  let s = newGame("b", Date.now(), false, partner);
  const rows: [string, number, string, string][] = [
    ["아니 말투가 샤갈 애인맞니?", 3, "말투부터 따짐", "말투를 먼저 지적하니 방어적이다"],
    ["너의 잠깐의 연락이 내 안식처가 된단 말이야", 15, "서운한 건 돌려 말하지 않음", "연락을 기다린 이유는 이제 알겠다"],
    ["4시간 넘으면 밥 사주는 규칙 하자", 14, "방법부터 꺼냄", "밥을 사는 것보다 연락 방법을 얘기하고 싶다"],
    ["나 무시해는 미안 내가 서운해서 그랬어", 12, "사과가 빠름", "그 말을 거둬들이니 조금 안심된다"],
    ["그날은 너가 밥사 ㅋㅋㅋ", 10, "무거우면 웃음으로 풂", "웃고 있지만 아직 할 말이 남았다"],
  ];
  for (const [player, drop, noticed, thought] of rows)
    s = recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], noticed, thought, suggested: drop, labels: ["emotion"] });
  return s;
};

const good = {
  summary: "기다린 이유를 말하자 윤재가 이해했지만 방법에서는 생각이 달랐어요.",
  received: "연락을 기다린 이유가 윤재에게 전해졌어요.",
  gap: "플레이어는 밥을 사는 규칙을 냈지만 윤재는 연락 방법을 더 이야기하고 싶었어요.",
  direction: "서로 원하는 연락 방식이 무엇인지 함께 살펴보면 좋겠습니다.",
  evidence: [
    { turn: 2, playerQuote: "내 안식처가 된단 말이야", thoughtQuote: "기다린 이유는 이제 알겠다" },
    { turn: 3, playerQuote: "밥 사주는 규칙", thoughtQuote: "연락 방법을 얘기하고 싶다" },
  ],
};

describe("근거 검사", () => {
  it("그 마디에서 실제로 한 말이어야 근거로 인정한다 (공백·문장부호 차이는 괜찮다)", () => {
    const s = game();
    expect(quoteIsReal(s, 2, "내 안식처가 된단 말이야")).toBe(true);
    expect(quoteIsReal(s, 2, "내안식처가  된단말이야!")).toBe(true);
    expect(quoteIsReal(s, 3, "내 안식처가")).toBe(false); // 다른 마디의 말
    expect(quoteIsReal(s, 2, "넌 원래 질투가 많잖아")).toBe(false); // 지어낸 말
    expect(quoteIsReal(s, 9, "아무거나")).toBe(false); // 없는 마디
    expect(thoughtQuoteIsReal(s, 2, "기다린 이유는 이제 알겠다")).toBe(true);
    expect(thoughtQuoteIsReal(s, 3, "기다린 이유는 이제 알겠다")).toBe(false);
  });

  it("엄격한 시도: 내 말이나 속마음 인용이 하나라도 가짜면 다시 생성", () => {
    const fake = { ...good, evidence: [...good.evidence, { turn: 1, playerQuote: "원래 질투 많잖아", thoughtQuote: "방어적이다" }] };
    expect(() => parseBelief(game(), fake, true)).toThrow(/belief_evidence/);
    const inventedThought = { ...good, evidence: [{ ...good.evidence[0], thoughtQuote: "윤재는 사실 기뻤다" }, good.evidence[1]] };
    expect(() => parseBelief(game(), inventedThought, true)).toThrow(/belief_evidence/);
  });

  it("마지막 시도: 근거가 맞는 인용만 남긴다", () => {
    const fake = { ...good, evidence: [...good.evidence, { turn: 1, playerQuote: "원래 질투 많잖아", thoughtQuote: "방어적이다" }] };
    const out = parseBelief(game(), fake, false);
    expect(out.evidence.map((e) => e.turn)).toEqual([2, 3]);
  });

  it("근거가 하나도 없으면 받지 않는다", () => {
    const none = { ...good, evidence: [{ turn: 1, playerQuote: "없는 말", thoughtQuote: "" }] };
    expect(() => parseBelief(game(), none, false)).toThrow(/no_evidence/);
  });

  it("속마음이 있는 판은 실제 속마음과 대조해야 한다", () => {
    const noThought = { ...good, evidence: good.evidence.map((e) => ({ ...e, thoughtQuote: "" })) };
    expect(() => parseBelief(game(), noThought, false)).toThrow(/no_thought_evidence/);
  });

  it("예전 판처럼 속마음 기록이 없으면 내 말 근거만으로 표시한다", () => {
    const state = recordTurn(newGame("old", Date.now(), false), { player: "답을 기다렸어", npc: [{ type: "dialogue", content: "응" }], suggested: 2, labels: ["emotion"] });
    const output = { ...good, evidence: [{ turn: 1, playerQuote: "답을 기다렸어", thoughtQuote: "" }] };
    expect(parseBelief(state, output, true).evidence).toEqual(output.evidence);
  });

  it("같은 마디를 근거로 중복하지 않는다", () => {
    const duplicate = { ...good, evidence: [good.evidence[0], good.evidence[0]] };
    expect(() => parseBelief(game(), duplicate, true)).toThrow(/belief_evidence/);
  });

  it("성격 유형·심리 진단 라벨은 거부한다", () => {
    for (const bad of ["너 완전 ENFP 같아", "불안형 애착인 듯", "자존감이 낮아 보여"]) {
      expect(() => parseBelief(game(), { ...good, summary: bad }, false)).toThrow(/banned/);
    }
  });

  it("다음 대화의 방향은 존댓말 종결로만 받는다", () => {
    expect(() => parseBelief(game(), { ...good, direction: "서로 원하는 연락 방식을 함께 살펴보기." }, true)).toThrow(/direction_not_polite/);
    expect(parseBelief(game(), { ...good, direction: "서로 원하는 연락 방식을 함께 살펴보세요." }, true).direction).toBe("서로 원하는 연락 방식을 함께 살펴보세요.");
  });

  it("예전 마디별 피드백 캐시는 새 형식으로 보지 않는다", () => {
    expect(isCurrentBelief({ kind: "feedback", v: 2, points: [] })).toBe(false);
    expect(isCurrentBelief({ kind: "feedback", v: 3, ...good })).toBe(true);
  });
});

describe("프롬프트", () => {
  it("연인의 Core, 전체 대화와 속마음을 넣고 점수나 완성된 대사는 요구하지 않는다", () => {
    const p = buildBeliefPrompt(game());
    expect(p.system).toContain("# 인물 Core: 윤재");
    expect(p.system).toContain("대화 전체에서 플레이어가 한 말");
    expect(p.system).toContain("완성된 대사나 정답 문장을 쓰지 않는다");
    expect(p.system).toContain("존댓말 한 문장");
    expect(p.system).not.toContain("suggestion");
    expect(p.user).not.toContain("54% 움직였다");
    expect(p.user).toContain("- 플레이어: 너의 잠깐의 연락이 내 안식처가 된단 말이야");
    expect(p.user).toContain("- 그때 포착한 플레이어의 태도: 서운한 건 돌려 말하지 않음");
    expect(p.user).toContain("- 그때 윤재의 속마음: 연락을 기다린 이유는 이제 알겠다");
  });
  it("서아 판에는 윤재가 남지 않는다", () => {
    const p = buildBeliefPrompt(game("f"));
    expect(p.system + p.user).not.toContain("윤재");
  });
  it("알게 된 것(noticed)은 대사 전 평가에서 분리한다", () => {
    const out = parseNpcOutput({ beats: [{ type: "dialogue", content: "응" }], thought: "알겠어" });
    expect(out.reason).toBe("알겠어");
    expect(buildNpcPrompt(newGame("x", Date.now(), false), "안녕", "counter").system).not.toContain("suggested_drop");
  });
});

describe("대본 모드", () => {
  it("실제 말과 속마음에서 인용을 뽑아 새 형식을 만든다", async () => {
    const r = await writeBelief(game());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.belief.v).toBe(3);
      expect(r.belief.evidence.some((e) => e.thoughtQuote)).toBe(true);
      for (const e of r.belief.evidence) {
        expect(quoteIsReal(game(), e.turn, e.playerQuote)).toBe(true);
        if (e.thoughtQuote) expect(thoughtQuoteIsReal(game(), e.turn, e.thoughtQuote)).toBe(true);
      }
    }
  });
});
