import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { buildNpcPrompt, parseNpcOutput, scriptedReply } from "./npc.js";
import { applyDrop, checkMessage, finish, newGame, recordTurn, RULES, type GameState, type StrategyLabel } from "./rules.js";
import { decodeState, encodeState } from "./token.js";

const play = (drops: [string, number, StrategyLabel[]][]): GameState => {
  let s = newGame("t", Date.now(), false);
  for (const [player, suggested, labels] of drops) s = recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], suggested, labels });
  return s;
};

describe("점수 규칙", () => {
  it("제안값을 0~최대치로 자른다", () => {
    expect(applyDrop(50, ["emotion"])).toBe(RULES.maxDropPerTurn);
    expect(applyDrop(-5, ["emotion"])).toBe(0);
    expect(applyDrop(Number.NaN, [])).toBe(0);
  });
  it("압박만 있는 말은 작게만 줄인다", () => {
    expect(applyDrop(15, ["pressure"])).toBe(RULES.maxDropForPressure);
    expect(applyDrop(15, ["pressure", "emotion"])).toBe(15);
  });
  it("다섯 마디가 끝나면 결과가 정해진다", () => {
    const s = play([
      ["a", 3, ["pressure"]],
      ["b", 15, ["emotion"]],
      ["c", 14, ["compromise"]],
      ["d", 12, ["apology"]],
      ["e", 10, ["humor"]],
    ]);
    expect(s.finished).toBe(true);
    expect(s.score).toBe(100 - 3 - 15 - 14 - 12 - 10);
    expect(s.outcome).toBe("compromise");
  });
  it("충분히 흔들어도 다섯 마디를 끝까지 하고, 끝난 뒤에 성공을 판정한다", () => {
    const three = play([
      ["a", 20, ["emotion"]],
      ["b", 20, ["compromise"]],
      ["c", 20, ["empathy"]],
    ]);
    expect(three.finished).toBe(false);
    const five = play([
      ["a", 20, ["emotion"]],
      ["b", 20, ["compromise"]],
      ["c", 20, ["empathy"]],
      ["d", 20, ["apology"]],
      ["e", 20, ["humor"]],
    ]);
    expect(five.finished).toBe(true);
    expect(five.outcome).toBe("success");
    expect(five.score).toBe(0); // 100% 흔들기가 가능하다
  });
  it("발언권과 한 번에 쓸 수 있는 글자 수를 지킨다", () => {
    const s = newGame("t", Date.now(), false);
    expect(checkMessage(s, "  ").ok).toBe(false);
    expect(checkMessage(s, "가".repeat(RULES.messageMax + 1)).ok).toBe(false);
    expect(checkMessage({ ...s, charsUsed: RULES.charBudget - 2 }, "가나다").ok).toBe(false);
    expect(checkMessage(s, " 안녕 ").ok && checkMessage(s, " 안녕 ")).toMatchObject({ text: "안녕" });
  });
  it("포기하면 포기 엔딩", () => {
    expect(finish(newGame("t", Date.now(), false), "giveup").outcome).toBe("giveup");
  });
});

describe("상태 토큰", () => {
  it("서명이 맞으면 복원하고, 조작하면 거부한다", () => {
    const s = play([["안녕", 5, ["emotion"]]]);
    const token = encodeState(s);
    expect(decodeState(token)?.score).toBe(s.score);
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...s, score: 0 })).toString("base64url");
    expect(decodeState(`${forged}.${mac}`)).toBeNull();
    expect(decodeState(`${body}.x${mac}`)).toBeNull();
    expect(decodeState(token, s.startedAt + 1000 * 60 * 60 * 7)).toBeNull();
  });
});

describe("NPC 출력", () => {
  it("정해진 라벨만 남기고 따옴표를 벗긴다", () => {
    const out = parseNpcOutput({
      beats: [{ type: "dialogue", content: "“그래?”" }],
      evaluation: { suggested_drop: 7, labels: ["emotion", "weird"], reason: "ok" },
    });
    expect(out.beats[0]?.content).toBe("그래?");
    expect(out.labels).toEqual(["emotion"]);
  });
  it("형식이 틀리면 거부한다", () => {
    expect(() => parseNpcOutput({ beats: [], evaluation: { suggested_drop: 1 } })).toThrow();
  });
  it("프롬프트에 대화와 지금 상태가 들어간다", () => {
    const s = play([["점심 때 연락하는 게 어려워?", 3, ["pressure"]]]);
    const p = buildNpcPrompt(s, "안식처야");
    expect(p.user).toContain("점심 때 연락하는 게 어려워?");
    expect(p.user).toContain("안식처야");
    expect(p.system).toContain("단호하다");
    // B 형식: 2인칭, 말/행동 구분
    expect(p.user).toContain("- 너 (말): 팀장님 얘기는");
    expect(p.user).toContain("- 플레이어 (말): 안식처야");
    expect(p.system).toContain("하지 말 것");
  });
  it("대본 모드도 형식을 지킨다", () => {
    const r = scriptedReply(newGame("t", Date.now(), false), "미안해 내가 서운해서 그랬어");
    expect(r.labels).toContain("apology");
    expect(r.beats.length).toBeGreaterThan(0);
  });
});

describe("대화 리포트", () => {
  it("마디마다 내 말, 연인 대답, +%, 누적 %, 속마음을 담는다", () => {
    let st = newGame("r", Date.now(), false);
    const rows: [string, number, string][] = [
      ["윤재야 애인맞니?", 3, "말투부터 그러니까 좀 서운함"],
      ["너의 연락이 내 안식처야", 15, "그렇게까지 기다린 줄은 몰랐네"],
      ["4시간 넘으면 밥 사기", 14, "밥 내기는 좀 웃겼다"],
      ["나 무시해는 미안", 12, "그 말 듣고 좀 풀림"],
      ["그날은 너가 밥사 ㅋㅋㅋ", 10, "아 진짜 못 이기겠다"],
    ];
    for (const [player, drop, thought] of rows)
      st = recordTurn(st, { player, npc: [{ type: "dialogue", content: "응" }], thought, suggested: drop, labels: ["emotion"] });
    const r = buildReport(st);
    expect(r.kind).toBe("report");
    expect(r.turns.map((t) => t.gain)).toEqual([3, 15, 14, 12, 10]);
    expect(r.turns.map((t) => t.total)).toEqual([3, 18, 32, 44, 54]);
    expect(r.shake).toBe(54);
    expect(r.successShake).toBe(60);
    expect(r.outcome).toBe("compromise");
    expect(r.strongestTurn).toBe(2);
    expect(r.weakestTurn).toBe(1);
    expect(r.turns[1]?.thought).toBe("그렇게까지 기다린 줄은 몰랐네");
    expect(r.npcName).toBe("윤재");
  });
  it("모든 마디가 같으면 가장 큰·작은 말을 표시하지 않는다", () => {
    const st = play([["a", 5, ["emotion"]], ["b", 5, ["emotion"]]]);
    const r = buildReport(st);
    expect(r.strongestTurn).toBeNull();
    expect(r.weakestTurn).toBeNull();
  });
  it("속마음이 없던 예전 기록도 리포트를 만든다", () => {
    const r = buildReport(play([["a", 5, ["emotion"]]]));
    expect(r.turns[0]?.thought).toBeNull();
  });
});
