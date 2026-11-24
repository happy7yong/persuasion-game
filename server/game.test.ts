import { describe, expect, it } from "vitest";
import { buildReport } from "./report.js";
import { buildFactsPrompt, buildNpcPrompt, parseFacts, parseNpcOutput, scriptedReply } from "./npc.js";
import { applyDrop, checkMessage, finish, newGame, projectTurn, recordTurn, RULES, type GameState, type StrategyLabel, type TurnFacts } from "./rules.js";
import { decodeState, encodeState } from "./token.js";

const play = (drops: [string, number, StrategyLabel[]][]): GameState => {
  let s = newGame("t", Date.now(), false);
  for (const [player, suggested, labels] of drops) s = recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], suggested, labels });
  return s;
};

describe("점수 규칙", () => {
  it("답변 전에 이번 사과의 미안함 변화와 근거를 보여주고, 기록할 때 같은 상태·점수를 쓴다", () => {
    const apology = (quote: string): TurnFacts => ({
      v: 2, added: [], resolved: [], acts: [{ act: "apology", quote, refersTo: "" }],
      evaluation: { suggested_drop: 4, labels: ["apology"], reason: "사과", noticed: "-", evidence: [quote] },
    });
    const first = apology("미안해");
    const original = newGame("apology-projection", Date.now(), false);
    const afterFirst = recordTurn(original, { player: "미안해", npc: [{ type: "dialogue", content: "응" }], facts: first, suggested: 4, labels: ["apology"] });
    const second = apology("진짜 미안해");
    const projected = projectTurn(afterFirst, second, 4, ["apology"]);
    const prompt = buildNpcPrompt(afterFirst, "진짜 미안해", "counter", second);
    expect(afterFirst.currentMind.guilt).toBe(2);
    expect(projected.currentMind.guilt).toBe(3);
    expect(prompt.system).toContain("미안함 3");
    expect(prompt.system).toContain("미안함 2→3");
    expect(prompt.system).toContain("계기가 된 이번 발화: “진짜 미안해”");
    expect(prompt.system).toContain("변화한 축을 모두 말로 설명할 필요는 없다");
    expect(afterFirst.currentMind.guilt).toBe(2); // 생성 전 상태는 변하지 않는다
    const recorded = recordTurn(afterFirst, { player: "진짜 미안해", npc: [{ type: "dialogue", content: "왜 그렇게 미안해해?" }], facts: second, suggested: 4, labels: ["apology"] });
    expect(recorded.currentMind).toEqual(projected.currentMind);
    expect(recorded.score).toBe(projected.score);
    expect(recorded.progress).toEqual(projected.progress);
  });
  it("상태 점수는 처음 확정된 관계 변화에만 붙고 반복에는 붙지 않는다", () => {
    // 플레이어가 연인의 한계(L1)를 받아들이는 말: 점수 이벤트 + 방어심 하락
    const facts = (resolved: TurnFacts["resolved"]): TurnFacts => ({ v: 2, added: [], resolved, acts: [{ act: "accept", quote: "바로 못 볼 수 있지", refersTo: "L1" }], evaluation: { suggested_drop: 8, labels: ["empathy"], reason: "테스트", noticed: "테스트", evidence: [] } });
    let s = newGame("progress", Date.now(), false);
    s = recordTurn(s, { player: "일할 땐 바로 못 볼 수 있지", npc: [{ type: "dialogue", content: "응" }], facts: facts([{ id: "L1", by: "player", status: "accepted", quote: "바로 못 볼 수 있지" }]), suggested: 8, labels: ["empathy"] });
    expect(s.turns[0]?.scoreBreakdown).toMatchObject({ base: 8, eventBonus: 2, mindBonus: 1, applied: 11 });
    expect(s.ledger.find((x) => x.id === "L1")?.status).toBe("accepted");
    // 같은 항목은 이미 정리돼 다시 받아들일 수 없고, 같은 이벤트에 보너스도 다시 붙지 않는다
    s = recordTurn(s, { player: "응 바로 못 볼 수 있지", npc: [{ type: "dialogue", content: "응" }], facts: facts([]), suggested: 8, labels: ["empathy"] });
    expect(s.turns[1]?.scoreBreakdown).toMatchObject({ eventBonus: 0, applied: 8 });
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
    expect(p.user).toContain("- 너 (말): 아까 답 늦은 건 미안해.");
    expect(p.user).toContain("- 플레이어 (말): 안식처야");
    expect(p.system).toContain("하지 말 것");
  });
  it("1차 발화 분석은 대사를 쓰지 않고, Core 없이 장부와 원문만 본다", () => {
    const s = play([["점심 때 연락하는 게 어려워?", 3, ["pressure"]]]);
    const p = buildFactsPrompt(s, "바로 답장 말고 한 번만 알려줘");
    expect(p.system).toContain("대화의 기록원");
    expect(p.system).toContain("L1 [NPC · 한계");
    expect(p.system).not.toContain("인물 Core");
    expect(p.system).not.toContain("최근 대화 기억");
    expect(p.user).toContain("바로 답장 말고 한 번만 알려줘");
    const facts = parseFacts(s, "바로 답장 말고 한 번만 알려줘", {
      npcLast: [], npcResolved: [],
      acts: [{ act: "request", quote: "한 번만 알려줘", refersTo: "L1" }],
      playerNew: [{ kind: "request", issue: "availability", text: "바쁠 때 한 번만 알려 주기", quote: "한 번만 알려줘" }],
      playerResolved: [],
      evaluation: { suggested_drop: 8, labels: ["logic", "nope"], reason: "구체적 요구", noticed: "방법을 분명히 말함", evidence: [] },
    }, true);
    expect(facts.added[0]).toMatchObject({ id: "L4", by: "player", kind: "request", turn: 2 });
    expect(facts.evaluation.labels).toEqual(["logic"]);
  });
  it("대사 프롬프트에는 장부와 확인된 사실이 들어가고, 무엇을 말하라는 지시 블록은 없다", () => {
    const s = newGame("np", Date.now(), false);
    const facts: TurnFacts = { v: 2, added: [], resolved: [{ id: "L1", by: "player", status: "accepted", quote: "기다릴게" }], acts: [{ act: "accept", quote: "기다릴게", refersTo: "L1" }], evaluation: { suggested_drop: 6, labels: ["empathy"], reason: "-", noticed: "-", evidence: [] } };
    const p = buildNpcPrompt(s, "알았어 기다릴게", null, facts);
    expect(p.system).toContain("# 대화 장부");
    expect(p.system).toContain("L1 [너 · 한계 · availability · 받아들여짐");
    expect(p.system).toContain("# 방금 플레이어의 말에서 확인된 것");
    for (const gone of ["대화 연결 (최우선)", "관계 해석 (대사 전에 확정됨)", "최근 대화 기억", "대사 반영:", "지금 신경 쓰는 것"]) expect(p.system).not.toContain(gone);
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
