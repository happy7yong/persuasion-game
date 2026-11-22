// 은하 신문 1면: 1면에 실을 말은 엔진이 고르고, 금지 소재와 형식은 코드가 막는다.
import { describe, expect, it } from "vitest";
import { buildHeadlinePrompt, parseHeadline, pickHeadlineTurn, writeHeadline } from "./headline.js";
import { finish, newGame, recordTurn, type GameState } from "./rules.js";

const game = (drops: number[]): GameState => {
  let s = newGame("h", Date.now(), false, "m");
  drops.forEach((d, i) => {
    s = recordTurn(s, { player: `${i + 1}번째 말`, npc: [{ type: "dialogue", content: "응" }], suggested: d, labels: ["emotion"] });
  });
  return s;
};

const good = {
  title: "지구인의 '4시간 규칙', 은하 연애 헌법 제1조로",
  subtitle: "은하연애위원회 \"그 카페의 밥값이 역사를 바꿨다\"",
  textbook: "모든 것은 한 지구인이 카페에서 \"4시간 넘으면 밥 사\"라고 한 데서 시작되었다.",
  side_articles: ["은하 외식 연합, 4시간마다 할인 행사", "연락 지연 행성, 밥값 폭등", "세 번째 기사"],
};

describe("1면에 실을 말", () => {
  it("가장 많이 움직인 말을 고른다", () => {
    expect(pickHeadlineTurn(game([3, 12, 5]))).toBe(2);
  });
  it("같으면 나중 말을 고른다", () => {
    expect(pickHeadlineTurn(game([10, 4, 10]))).toBe(3);
  });
  it("말이 없으면 1면도 없다", async () => {
    const s = finish(newGame("h0", Date.now(), false), "giveup");
    expect(pickHeadlineTurn(s)).toBeNull();
    expect((await writeHeadline(s)).ok).toBe(false);
  });
  it("프롬프트에 결정적인 한마디를 표시한다", () => {
    const { user } = buildHeadlinePrompt(game([3, 12, 5]), 2);
    expect(user).toContain("\"2번째 말\" → 마음 +12%  ← 1면에 실릴 결정적인 한마디");
  });
});

describe("출력 검사", () => {
  it("곁다리 기사는 2개까지만 싣는다", () => {
    expect(parseHeadline(good, true).sideArticles).toHaveLength(2);
  });
  it("엄격한 시도: 교과서 문장 형식이 다르면 다시 생성, 마지막 시도는 받는다", () => {
    const off = { ...good, textbook: "한 지구인이 역사를 바꿨다." };
    expect(() => parseHeadline(off, true)).toThrow(/textbook_format/);
    expect(parseHeadline(off, false).textbook).toBe("한 지구인이 역사를 바꿨다.");
  });
  it("실존 인물·기업, 죽음·폭력 소재는 거부한다", () => {
    for (const bad of ["삼성, 은하 메신저 독점", "은하 전쟁 발발", "1,000명 사망"]) {
      expect(() => parseHeadline({ ...good, title: bad }, false)).toThrow(/banned/);
    }
  });
});

describe("대본 모드", () => {
  it("키 없이도 실제 한 말을 1면에 싣는다", async () => {
    const prev = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const r = await writeHeadline(game([3, 12, 5]));
      expect(r.ok && r.headline.quote).toBe("2번째 말");
      expect(r.ok && r.headline.quoteTurn).toBe(2);
    } finally {
      if (prev !== undefined) process.env.OPENROUTER_API_KEY = prev;
    }
  });
});
