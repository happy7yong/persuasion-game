// 대사 검증기 V2(재주장)·V3(장면 이탈)와 "첫 시도만 거부, 마지막 시도는 통과·기록" 정책.
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkOutcome, reassertViolation, sceneTriggers } from "./checks.js";
import { applyFacts, initialLedger, type TurnFacts } from "./ledger.js";
import { npcReply } from "./npc.js";
import { newGame } from "./rules.js";

const evaluation = { suggested_drop: 6, labels: ["empathy"], reason: "-", noticed: "-", evidence: [] };
// 플레이어가 윤재의 걱정(L2: 일부러 피한 게 아니다)을 받아들인 뒤의 장부
const accepted: TurnFacts = { v: 2, added: [], resolved: [{ id: "L2", by: "player", status: "accepted", quote: "단정하지 않을게" }], acts: [{ act: "accept", quote: "단정하지 않을게", refersTo: "L2" }], evaluation };
const ledger = applyFacts(initialLedger(), accepted, 1);

describe("V2 재주장", () => {
  it("정리된 주장을 다시 내세우면 위반, 인정·언급은 허용", () => {
    expect(reassertViolation(ledger, [{ id: "L2", use: "assert" }])).toBe("reasserts_resolved:L2");
    expect(reassertViolation(ledger, [{ id: "L2", use: "acknowledge" }])).toBeNull();
    expect(reassertViolation(ledger, [{ id: "L2", use: "reference" }])).toBeNull();
  });
  it("아직 열린 주장은 다시 말해도 된다", () => {
    expect(reassertViolation(ledger, [{ id: "L1", use: "assert" }])).toBeNull();
  });
});

describe("V3 거름망", () => {
  it("장면과 어긋날 수 있는 표현을 고른다 (회상도 걸리지만 판정이 결정한다)", () => {
    expect(sceneTriggers("나 아직 한두 시간은 더 걸릴 것 같아. 끝나면 갈게")).toEqual(expect.arrayContaining(["끝나면", "가자·갈게·와줘"]));
    expect(sceneTriggers("아까 회의 끝나고 바로 왔어")).toEqual(["끝나고"]);
    expect(sceneTriggers("응, 그건 고마워.")).toEqual([]);
  });
  it("기준선에서 놓친 실제 이탈(남은 시간을 말함)을 판정으로 보낸다", () => {
    expect(sceneTriggers("나 아직 한두 시간은 더 걸릴 것 같아.")).toContain("남은 시간");
    expect(sceneTriggers("곧 끝나. 여기서 기다리면 돼.")).toContain("남은 시간");
    expect(sceneTriggers("두 시간 정도 걸릴 것 같아")).toContain("남은 시간");
    // 남은 시간과 상관없는 말은 그대로 통과 (판정 호출을 늘리지 않게)
    expect(sceneTriggers("그 말 들으니까 시간 들여서 얘기한 보람이 있네.")).toEqual([]);
  });
});

describe("V3 판정 원칙", () => {
  it("판정 대상은 연인이 직접 주장한 것이고, 플레이어 전제를 바로잡는 말은 정상이다", async () => {
    const { buildSceneCheckPrompt, SCENE_JSON_SCHEMA, parseSceneVerdict } = await import("./checks.js");
    const p = buildSceneCheckPrompt([], "서아", "언제 끝나? 데리러 갈게", "지금 마주 앉아 있는데 데리러 올 건 아니고, 그냥 여기 있어.");
    expect(p.system).toContain("claim");
    expect(p.system).toContain("플레이어 말의 전제");
    expect(SCENE_JSON_SCHEMA.required).toEqual(["claim", "verdict", "reason"]);
    expect(parseSceneVerdict({ claim: "지금 여기 같이 있다", verdict: "ok", reason: "정정" }).verdict).toBe("ok");
    expect(() => parseSceneVerdict({ verdict: "ok", reason: "x" })).toThrow();
  });
});

describe("refs 자기 보고", () => {
  it("많이 적어도 대사를 거부하지 않고 앞의 6개만 쓴다", async () => {
    const { parseNpcOutput } = await import("./npc.js");
    const refs = Array.from({ length: 9 }, (_, i) => ({ id: `L${i + 1}`, use: "acknowledge" }));
    expect(parseNpcOutput({ beats: [{ type: "dialogue", content: "응" }], thought: "음", refs }).refs).toHaveLength(6);
  });
});

describe("결과 분류", () => {
  const c = (violations: string[], attempt = 1) => ({ attempt, last: attempt === 2, violations, sceneTriggers: [], refs: [] });
  it("첫 시도 통과 · 거부 뒤 재생성 성공 · 마지막에도 위반", () => {
    expect(checkOutcome([c([])])).toBe("clean");
    expect(checkOutcome([c(["reasserts_resolved:L2"]), c([], 2)])).toBe("prevented");
    expect(checkOutcome([c(["reasserts_resolved:L2"]), c(["reasserts_resolved:L2"], 2)])).toBe("exposed");
  });
});

describe("대사 호출에 검증 연결", () => {
  const body = (content: string) => new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }));
  const facts = JSON.stringify({
    npcLast: [], npcResolved: [], playerNew: [],
    playerResolved: [{ id: "L2", status: "accepted", quote: "단정하지 않을게" }],
    acts: [{ act: "accept", quote: "단정하지 않을게", refersTo: "L2" }],
    evaluation: { ...evaluation, labels: ["empathy"] },
  });
  const reassert = JSON.stringify({ move: "counter", beats: [{ type: "dialogue", content: "근데 나 진짜 일부러 무시한 건 아니었어." }], thought: "그래도 그건 말해야지", refs: [{ id: "L2", use: "assert" }] });
  const thanks = JSON.stringify({ move: "counter", beats: [{ type: "dialogue", content: "그렇게 말해줘서 고마워. 나도 오늘은 좀 서운했어." }], thought: "조금 풀렸다", refs: [{ id: "L2", use: "acknowledge" }] });
  const old = { key: process.env.OPENROUTER_API_KEY, scripted: process.env.SCRIPTED };
  const live = () => {
    process.env.OPENROUTER_API_KEY = "test";
    delete process.env.SCRIPTED;
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [["OPENROUTER_API_KEY", old.key], ["SCRIPTED", old.scripted]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("첫 시도의 재주장은 거부하고, 거부 이유를 붙여 다시 생성한다 (prevented)", async () => {
    live();
    const sent: string[] = [];
    const replies = [facts, reassert, thanks];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => (sent.push(init.body), body(replies.shift()!))));
    const r = await npcReply(newGame("v2", Date.now(), false), "응 알겠어 씹었다고 단정하지 않을게");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.outcome).toBe("prevented");
    expect(r.reply.checks.map((c) => c.violations)).toEqual([["reasserts_resolved:L2"], []]);
    expect(r.reply.beats[0]?.content).toContain("고마워");
    expect(sent[2]).toContain("직전 시도가 거부된 이유");
    expect(sent[1]).not.toContain("직전 시도가 거부된 이유");
  });

  it("마지막 시도까지 위반이면 대화를 끊지 않고 보여 주되 exposed로 기록한다", async () => {
    live();
    const replies = [facts, reassert, reassert];
    vi.stubGlobal("fetch", vi.fn(async () => body(replies.shift()!)));
    const r = await npcReply(newGame("v2b", Date.now(), false), "응 알겠어 씹었다고 단정하지 않을게");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reply.outcome).toBe("exposed");
  });
});
