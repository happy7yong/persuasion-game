// 윤재가 대화를 끌고 가지 않도록: 끝맺음 방식은 서버가 정하고 출력이 지켰는지 검사한다.
import { describe, expect, it } from "vitest";
import { buildNpcPrompt, moveViolation, parseNpcOutput } from "./npc.js";
import { chooseMove, newGame, recordTurn, RULES, type GameState, type NpcMove, type StrategyLabel } from "./rules.js";

const step = (s: GameState, suggested: number, labels: StrategyLabel[] = ["emotion"], player = "말"): GameState =>
  recordTurn(s, { player, npc: [{ type: "dialogue", content: "응" }], move: chooseMove(s), suggested, labels });

describe("끝맺음 방식 고르기", () => {
  it("여러 판에서 질문은 한 판 최대 2번, 연속 없음, 마지막 마디 없음", () => {
    for (let i = 0; i < 300; i++) {
      let s = newGame(`p${i}`, Date.now(), false);
      const moves: NpcMove[] = [];
      while (!s.finished) {
        moves.push(chooseMove(s));
        s = step(s, 4);
      }
      expect(moves.filter((m) => m === "ask").length).toBeLessThanOrEqual(2);
      for (let j = 1; j < moves.length; j++) expect(moves[j] === "ask" && moves[j - 1] === "ask").toBe(false);
      expect(moves[RULES.maxTurns - 1]).not.toBe("ask");
    }
  });

  it("단호한 구간에서는 반론이 가장 많다", () => {
    const tally = { counter: 0, ask: 0, concede: 0, linger: 0 };
    for (let i = 0; i < 400; i++) tally[chooseMove(newGame(`q${i}`, Date.now(), false))]++;
    expect(tally.counter).toBeGreaterThan(tally.linger);
    expect(tally.ask).toBe(0); // 첫 마디는 묻지 않고 받아친다
    expect(tally.concede).toBe(0);
  });

  it("같은 판, 같은 마디에서는 같은 방식 (재시도·따라잡기에도 안정)", () => {
    const s = newGame("same", Date.now(), false);
    expect(chooseMove(s)).toBe(chooseMove(s));
  });

  it("프롬프트에 이번 끝맺음 방식이 들어가고, 먼저 제안하지 말라는 규칙이 있다", () => {
    const p = buildNpcPrompt(newGame("x", Date.now(), false), "안녕", "counter");
    expect(p.system).toContain("반론:");
    expect(p.system).toContain("먼저 제안하지 않는다");
    expect(p.system).not.toContain("마지막 beat는 플레이어가 대답할 수 있게");
  });
});

describe("끝맺음 검사", () => {
  const d = (content: string) => ({ type: "dialogue", content });
  const n = (content: string) => ({ type: "narration", content });
  it("반론·수긍은 질문으로 끝나면 위반", () => {
    expect(moveViolation("counter", [d("나 화요일은 회의만 다섯 개거든.")])).toBeNull();
    expect(moveViolation("counter", [d("근데 그럼 넌 어떻게 하고 싶어?")])).toMatch(/question/);
    expect(moveViolation("concede", [d("알았어."), d("대신 봐줄 거지?")])).toMatch(/question/);
  });
  it("질문은 ask일 때만 허용", () => {
    expect(moveViolation("ask", [d("제일 서운했던 게 뭐였어?")])).toBeNull();
  });
  it("여운은 행동 묘사로 끝난다", () => {
    expect(moveViolation("linger", [d("…그렇구나."), n("윤재가 잔을 내려다본다.")])).toBeNull();
    expect(moveViolation("linger", [d("…그렇구나.")])).toBe("linger_not_narration");
  });
  it("엄격 모드에서만 거부하고, 마지막 시도는 형식만 본다", () => {
    const raw = { beats: [d("넌 어떻게 생각해?")], evaluation: { suggested_drop: 5, labels: [], reason: "" } };
    expect(() => parseNpcOutput(raw, "counter", true)).toThrow(/move_violation/);
    expect(parseNpcOutput(raw, "counter", false).move).toBe("counter");
  });
});
