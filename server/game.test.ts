import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { buildNpcPrompt, buildTurnFramePrompt, parseNpcOutput, parseTurnFrame, scriptedReply } from "./npc.js";
import { applyDrop, applyStateUpdate, checkMessage, finish, newGame, recordTurn, RULES, type GameState, type StrategyLabel } from "./rules.js";
import { decodeState, encodeState } from "./token.js";

const play = (drops: [string, number, StrategyLabel[]][]): GameState => {
  let s = newGame("t", Date.now(), false);
  for (const [player, suggested, labels] of drops) s = recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], suggested, labels });
  return s;
};

describe("점수 규칙", () => {
  it("세션 현재 마음은 한 턴에 한 단계만 바뀌고 관계 상태는 근거와 함께 쌓인다", () => {
    const s = newGame("mind", Date.now(), false);
    const next = applyStateUpdate(s, {
      mind: { fatigue: 0, guilt: 3, defensiveness: 0, care: 3, openness: 3, focus: "읽음 뒤 공백", want: "걱정을 직접 말해주길 바람" },
      acknowledge: ["읽고 답을 미룬 일은 불안을 만들었음"], retain: [], resolve: [], playerStance: ["무시라고 단정하지 않겠음"], propose: ["나중에 이유를 먼저 말하기"], agreement: "mutual", evidence: ["나는 무시라고 단정하지 않을게"], progress: [],
    });
    expect(next.currentMind.guilt).toBe(2);
    expect(next.currentMind.defensiveness).toBe(2);
    expect(next.relationship.acknowledged[0]?.sourceTurn).toBe(1);
    expect(next.relationship.agreement).toBe("none");
  });
  it("상태 점수는 처음 확정된 관계 변화에만 붙고 반복에는 붙지 않는다", () => {
    const frame = (s: GameState) => ({ request: "-", reason: "-", acknowledge: "읽음 뒤 공백", retain: "즉답은 어려움", focus: "불안", continuity: { respondsTo: "직전 대화", playerAct: "other" as const, accepted: "없음", notAccepted: "없음", mustAddress: "불안", doNotRepeat: [] }, evaluation: { suggested_drop: 8, labels: ["emotion"] as StrategyLabel[], reason: "테스트 평가", noticed: "테스트", evidence: ["읽고도 아무 말이 없었어"] }, stateUpdate: { mind: s.currentMind, acknowledge: ["읽고 답을 미룬 일은 불안을 만들었음"], retain: [], resolve: [], playerStance: [], propose: [], agreement: "none" as const, evidence: ["읽고도 아무 말이 없었어"], progress: [{ type: "acknowledged" as const, issue: "read-gap" as const }] } });
    let s = newGame("progress", Date.now(), false);
    s = recordTurn(s, { player: "읽고도 아무 말이 없었어", npc: [{ type: "dialogue", content: "미안" }], frame: frame(s), suggested: 8, labels: ["emotion"] });
    expect(s.turns[0]?.applied).toBe(9);
    s = recordTurn(s, { player: "또 읽고도 아무 말이 없었어", npc: [{ type: "dialogue", content: "응" }], frame: frame(s), suggested: 20, labels: ["emotion"] });
    expect(s.turns[1]?.applied).toBe(14);
  });
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
  it("대사와 속마음을 받고 따옴표를 벗긴다", () => {
    const out = parseNpcOutput({
      beats: [{ type: "dialogue", content: "“그래?”" }],
      thought: "그렇구나",
    });
    expect(out.beats[0]?.content).toBe("그래?");
    expect(out.reason).toBe("그렇구나");
  });
  it("형식이 틀리면 거부한다", () => {
    expect(() => parseNpcOutput({ beats: [] })).toThrow();
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
  it("대사 전 관계 해석은 요구·이유·인정·유지 입장을 분리한다", () => {
    const s = play([["점심 때 연락하는 게 어려워?", 3, ["pressure"]]]);
    const p = buildTurnFramePrompt(s, "바로 답장 말고 한 번만 알려줘");
    expect(p.system).toContain("대사를 쓰지 않는 관계 대화 해석기");
    expect(p.system).toContain('"NPC가 한 행동 → 플레이어에게 생긴 결과" 형태');
    expect(p.user).toContain("바로 답장 말고 한 번만 알려줘");
    expect(
      parseTurnFrame({
        request: "시간 될 때 한 번 짧게 연락하기",
        reason: "답이 없으면 걱정됨",
        acknowledge: "오래 기다리게 한 사실",
        retain: "회의 중에는 바로 답하기 어려움",
        focus: "한 번의 연락이 가능한 범위",
        continuity: { respondsTo: "점심 때 연락이 어렵다는 설명", playerAct: "new_request", accepted: "즉답이 어려울 수 있음", notAccepted: "사전 안내 없는 침묵", mustAddress: "한 번 알리는 방법", doNotRepeat: ["회의가 바빴다는 설명"] },
        evaluation: { suggested_drop: 8, labels: ["logic"], reason: "요구는 구체적이지만 핵심 반론에는 아직 답하지 않음", noticed: "방법을 분명히 말함", evidence: ["바로 답장 말고 한 번만 알려줘"] },
        stateUpdate: {
          mind: { fatigue: 3, guilt: 2, defensiveness: 2, care: 2, openness: 2, focus: "연락 공백이 만든 불안", want: "걱정을 직접 말해주길 바람" },
          acknowledge: ["읽고 답을 미룬 일은 불안을 만들었음"], retain: ["회의 중 바로 답하기 어려움"], resolve: [], playerStance: [], propose: [], agreement: "discussing", evidence: ["바로 답장 말고 한 번만 알려줘"], progress: [],
        },
      }),
    ).toMatchObject({ request: "시간 될 때 한 번 짧게 연락하기" });
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
    expect(r.successShake).toBe(70);
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
