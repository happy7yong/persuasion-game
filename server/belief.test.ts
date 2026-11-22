// "내가 본 너": 판단마다 실제로 한 말이 근거로 붙는지, 지어낸 근거와 진단 라벨은 막히는지.
import { describe, expect, it } from "vitest";
import { buildBeliefPrompt, parseBelief, quoteIsReal, writeBelief } from "./belief.js";
import { buildNpcPrompt, parseNpcOutput } from "./npc.js";
import { newGame, recordTurn, type GameState } from "./rules.js";

const game = (partner: "m" | "f" = "m"): GameState => {
  let s = newGame("b", Date.now(), false, partner);
  const rows: [string, number, string][] = [
    ["아니 말투가 샤갈 애인맞니?", 3, "말투부터 따짐"],
    ["너의 잠깐의 연락이 내 안식처가 된단 말이야", 15, "서운한 건 돌려 말하지 않음"],
    ["4시간 넘으면 밥 사주는 규칙 하자", 14, "방법부터 꺼냄"],
    ["나 무시해는 미안 내가 서운해서 그랬어", 12, "사과가 빠름"],
    ["그날은 너가 밥사 ㅋㅋㅋ", 10, "무거우면 웃음으로 풂"],
  ];
  for (const [player, drop, noticed] of rows)
    s = recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], noticed, thought: "음", suggested: drop, labels: ["emotion"] });
  return s;
};

const good = {
  summary: "구체적인 이유를 말한 마디가 설득에 도움이 됐어요.",
  points: [
    { strength: "감정의 이유를 직접 말했어요", turn: 2, quote: "내 안식처가 된단 말이야", improve: "윤재의 업무 한계에는 아직 답하지 못했어요", suggestion: "바쁜 건 이해해. 대신 내가 불안했던 이유도 봐줘." },
    { strength: "구체적인 방법을 제안했어요", turn: 3, quote: "밥 사주는 규칙", improve: "상대가 할 수 있는 범위를 함께 확인하면 좋아요", suggestion: "네가 가능한 방식으로 한 가지만 정해보자." },
  ],
  closing: "상대의 한계를 인정한 뒤 원하는 행동을 하나로 좁혀 말해보세요.",
};

describe("근거 검사", () => {
  it("그 마디에서 실제로 한 말이어야 근거로 인정한다 (공백·문장부호 차이는 괜찮다)", () => {
    const s = game();
    expect(quoteIsReal(s, 2, "내 안식처가 된단 말이야")).toBe(true);
    expect(quoteIsReal(s, 2, "내안식처가  된단말이야!")).toBe(true);
    expect(quoteIsReal(s, 3, "내 안식처가")).toBe(false); // 다른 마디의 말
    expect(quoteIsReal(s, 2, "넌 원래 질투가 많잖아")).toBe(false); // 지어낸 말
    expect(quoteIsReal(s, 9, "아무거나")).toBe(false); // 없는 마디
  });

  it("엄격한 시도: 근거가 하나라도 가짜면 다시 생성", () => {
    const fake = { ...good, points: [...good.points, { strength: "x", turn: 1, quote: "원래 질투 많잖아", improve: "x", suggestion: "x" }] };
    expect(() => parseBelief(game(), fake, true)).toThrow(/belief_evidence/);
  });

  it("마지막 시도: 근거가 맞는 판단만 남긴다", () => {
    const fake = { ...good, points: [...good.points, { strength: "x", turn: 1, quote: "원래 질투 많잖아", improve: "x", suggestion: "x" }] };
    const out = parseBelief(game(), fake, false);
    expect(out.points.map((p) => p.turn)).toEqual([2, 3]);
  });

  it("근거가 하나도 없으면 받지 않는다", () => {
    const none = { ...good, points: [{ strength: "x", turn: 1, quote: "없는 말", improve: "x", suggestion: "y" }] };
    expect(() => parseBelief(game(), none, false)).toThrow(/no_evidence/);
  });

  it("성격 유형·심리 진단 라벨은 거부한다", () => {
    for (const bad of ["너 완전 ENFP 같아", "불안형 애착인 듯", "자존감이 낮아 보여"]) {
      expect(() => parseBelief(game(), { ...good, summary: bad }, false)).toThrow(/banned/);
    }
  });
});

describe("프롬프트", () => {
  it("연인의 Core, 결과, 마디별 말과 알게 된 것을 넣는다", () => {
    const p = buildBeliefPrompt(game());
    expect(p.system).toContain("# 인물 Core: 윤재");
    expect(p.system).toContain("다음 대화에서 더 잘 설득");
    expect(p.user).toContain("54% 움직였다");
    expect(p.user).toContain("- 플레이어: 너의 잠깐의 연락이 내 안식처가 된단 말이야");
    expect(p.user).toContain("- 그때 포착한 플레이어의 태도: 서운한 건 돌려 말하지 않음");
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
  it("실제 말에서 인용을 뽑아 검사를 통과하는 판단을 만든다", async () => {
    const r = await writeBelief(game());
    expect(r.ok).toBe(true);
    if (r.ok) for (const p of r.belief.points) expect(quoteIsReal(game(), p.turn, p.quote)).toBe(true);
  });
});
