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
  summary: "내가 본 너는 서운한 걸 참는 사람은 아닌 것 같아.",
  points: [
    { claim: "서운한 건 돌려 말하지 않는 사람", turn: 2, quote: "내 안식처가 된단 말이야", why: "그렇게까지 말할 줄은 몰랐거든." },
    { claim: "방법부터 꺼내는 사람", turn: 3, quote: "밥 사주는 규칙", why: "싸우다 말고 밥 얘기라니." },
  ],
  expectation: "다음에 내가 또 연락 못 하면, 너는 아마 밥부터 사라고 하겠지.",
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
    const fake = { ...good, points: [...good.points, { claim: "질투가 많은 사람", turn: 1, quote: "원래 질투 많잖아", why: "그냥 느낌" }] };
    expect(() => parseBelief(game(), fake, true)).toThrow(/belief_evidence/);
  });

  it("마지막 시도: 근거가 맞는 판단만 남긴다", () => {
    const fake = { ...good, points: [...good.points, { claim: "질투가 많은 사람", turn: 1, quote: "원래 질투 많잖아", why: "그냥 느낌" }] };
    const out = parseBelief(game(), fake, false);
    expect(out.points.map((p) => p.turn)).toEqual([2, 3]);
  });

  it("근거가 하나도 없으면 받지 않는다", () => {
    const none = { ...good, points: [{ claim: "x", turn: 1, quote: "없는 말", why: "y" }] };
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
    expect(p.system).toContain("틀릴 수 있다");
    expect(p.user).toContain("54% 움직였다");
    expect(p.user).toContain("- 플레이어: 너의 잠깐의 연락이 내 안식처가 된단 말이야");
    expect(p.user).toContain("- 그때 네가 알게 된 것: 서운한 건 돌려 말하지 않음");
  });
  it("서아 판에는 윤재가 남지 않는다", () => {
    const p = buildBeliefPrompt(game("f"));
    expect(p.system + p.user).not.toContain("윤재");
  });
  it("마디 응답에서 알게 된 것(noticed)을 받는다", () => {
    const out = parseNpcOutput({ beats: [{ type: "dialogue", content: "응" }], evaluation: { suggested_drop: 5, labels: [], reason: "r", noticed: "방법부터 꺼냄" } });
    expect(out.noticed).toBe("방법부터 꺼냄");
    expect(buildNpcPrompt(newGame("x", Date.now(), false), "안녕", "counter").system).toContain("noticed");
  });
});

describe("대본 모드", () => {
  it("실제 말에서 인용을 뽑아 검사를 통과하는 판단을 만든다", async () => {
    const r = await writeBelief(game());
    expect(r.ok).toBe(true);
    if (r.ok) for (const p of r.belief.points) expect(quoteIsReal(game(), p.turn, p.quote)).toBe(true);
  });
});
