// 실험 1 조건 B (캐릭터 직접 해석, docs/appraisal-review.md §14). 유료 호출 없음.
// - B 프롬프트에 1차의 의미 라벨·BAND·장부 상태어·끝맺음 지정이 들어가지 않는다
// - A(서비스 프롬프트)는 그대로다
// - B 출력은 변화 없음(빈 shift·want)을 허용한다
// - 검증기와 재시도 정책은 A와 같고, 첫 시도와 최종 대사를 구분해 기록한다
import { afterEach, describe, expect, it, vi } from "vitest";
import { BAND_GUIDE, MOVE_GUIDE } from "./content.js";
import { applyFacts, initialLedger, spokenLines, type TurnFacts } from "./ledger.js";
import { appraisalReplyFromFacts, buildAppraisalPrompt, buildNpcPrompt, npcReply, parseAppraisalOutput, replyFromFacts } from "./npc.js";
import { newGame, recordTurn, type GameState } from "./rules.js";

const evaluation = { suggested_drop: 6, labels: ["empathy"], reason: "-", noticed: "-", evidence: [] };
// 2마디째: 플레이어가 "알았어 기다릴게"라고 했고, 1차가 이를 L1 수용으로 기록한 상황 (기록이 틀렸을 수도 있다)
const facts: TurnFacts = {
  v: 2,
  added: [],
  resolved: [{ id: "L1", by: "player", status: "accepted", quote: "기다릴게" }],
  acts: [{ act: "accept", quote: "기다릴게", refersTo: "L1" }],
  evaluation,
};
const state = (): GameState =>
  recordTurn(newGame("ap", Date.now(), false), {
    player: "오늘 연락 없어서 많이 서운했어",
    npc: [{ type: "dialogue", content: "일부러 그런 건 아니야. 회의가 계속 이어져서 폰을 못 봤어. 일할 땐 바로 답하기 어려워." }],
    move: "counter",
    suggested: 0,
    labels: [],
  });

describe("B 프롬프트: 캐릭터가 직접 해석하도록 판정을 미리 주지 않는다", () => {
  const p = buildAppraisalPrompt(state(), "알았어 기다릴게", facts);

  it("BAND 마음 묘사·1차의 의미 라벨·장부 상태어·끝맺음 지정이 없다", () => {
    for (const band of Object.values(BAND_GUIDE)) expect(p.system).not.toContain(band);
    for (const guide of Object.values(MOVE_GUIDE)) expect(p.system).not.toContain(guide);
    expect(p.system).not.toContain("# 방금 플레이어의 말에서 확인된 것");
    expect(p.system).not.toContain("# 이번 차례를 끝내는 방식");
    expect(p.system).not.toContain("받아들여짐");
    // 장부 상태어 "열림" (마음 축 이름 "마음 열림"은 상태어가 아니다)
    expect(p.system).not.toMatch(/· 열림|"열림"/);
    expect(p.system).not.toMatch(/: 수용 \(/);
  });

  it("원문·실제로 말해진 것·Core·듣기 전 마음을 받는다", () => {
    expect(p.system).toContain("# 인물 Core: 윤재");
    expect(p.system).toContain("# 듣기 전 네 마음");
    expect(p.system).toContain("# 지금까지 실제로 말해진 것");
    expect(p.system).toContain("플레이어가 2마디에 이 항목에 대해 말함: “기다릴게”");
    expect(p.user).toContain("- 플레이어 (말): 알았어 기다릴게");
    expect(p.system).toContain("그 말을 어떻게 받아들일지는 네가 정한다");
  });

  it("판정어 없는 기록: 상태·종류·쟁점을 쓰지 않는다", () => {
    const lines = spokenLines(applyFacts(initialLedger(), facts, 2));
    expect(lines).toContain("- L1 너가 장면 시작에 말함:");
    expect(lines).not.toMatch(/받아들여짐|열림|availability|한계|걱정/);
  });

  it("서아에게는 서아의 Core가 들어간다", () => {
    const f = recordTurn(newGame("ap-f", Date.now(), false, "f"), { player: "x", npc: [{ type: "dialogue", content: "y" }], move: "counter", suggested: 0, labels: [] });
    expect(buildAppraisalPrompt(f, "응", { ...facts, resolved: [], acts: [{ act: "other", quote: "응", refersTo: "" }] }).system).toContain("# 인물 Core: 서아");
  });
});

describe("A 프롬프트(서비스)는 그대로다", () => {
  it("BAND·의미 라벨·장부 상태어·끝맺음 지정이 지금처럼 들어간다", () => {
    const p = buildNpcPrompt(state(), "알았어 기다릴게", "counter", facts);
    expect(p.system).toContain("# 지금 상태");
    expect(p.system).toContain("# 방금 플레이어의 말에서 확인된 것");
    expect(p.system).toContain("- 플레이어의 말 “기다릴게”: 수용 (L1에 대해)");
    expect(p.system).toContain("받아들여짐");
    expect(p.system).toContain(`# 이번 차례를 끝내는 방식\n${MOVE_GUIDE.counter}`);
    expect(p.system).toContain("# 직전 응답과 반복 금지");
  });
});

describe("B 출력: 변하지 않을 자유", () => {
  it("빈 shift와 빈 want를 허용한다", () => {
    const o = parseAppraisalOutput({ heard: "“응”이라니, 그냥 넘어가는 건가", shift: [], want: "", beats: [{ type: "dialogue", content: "응." }], refs: [] });
    expect(o.shift).toEqual([]);
    expect(o.want).toBe("");
  });
  it("한 번에 한 단계(±1)만, 정해진 축만", () => {
    expect(() => parseAppraisalOutput({ heard: "x", shift: [{ axis: "defensiveness", delta: -2, why: "x" }], want: "", beats: [{ type: "dialogue", content: "응" }], refs: [] })).toThrow();
    expect(() => parseAppraisalOutput({ heard: "x", shift: [{ axis: "trust", delta: 1, why: "x" }], want: "", beats: [{ type: "dialogue", content: "응" }], refs: [] })).toThrow();
  });
});

describe("B 대사 호출: 검증기는 A와 같고, 첫 시도와 최종을 구분해 기록한다", () => {
  const body = (content: string) => new Response(JSON.stringify({ model: "m", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 } }));
  const out = (dialogue: string, refs: { id: string; use: string }[]) => JSON.stringify({ heard: "“기다릴게”가 체념처럼 들린다", shift: [], want: "진짜 괜찮은지 알고 싶다", beats: [{ type: "dialogue", content: dialogue }], refs });
  const old = { key: process.env.OPENROUTER_API_KEY, scripted: process.env.SCRIPTED };
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const [k, v] of [["OPENROUTER_API_KEY", old.key], ["SCRIPTED", old.scripted]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const live = () => {
    process.env.OPENROUTER_API_KEY = "test";
    delete process.env.SCRIPTED;
  };

  it("1차가 L1을 '받아들여짐'으로 기록했으면, B가 L1을 다시 주장할 때 V2가 첫 시도를 거부한다 (V2 영향 기록)", async () => {
    live();
    const sent: string[] = [];
    const replies = [out("근데 일할 땐 진짜 바로 답하기 어려워.", [{ id: "L1", use: "assert" }]), out("…진짜 괜찮은 거 맞아?", [])];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => (sent.push(init.body), body(replies.shift()!))));
    const r = await appraisalReplyFromFacts(state(), "알았어 기다릴게", facts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reply.checks.map((c) => c.violations)).toEqual([["reasserts_resolved:L1"], []]);
    expect(r.reply.outcome).toBe("prevented");
    expect(r.reply.endsWithQuestion).toBe(true);
    // 첫 시도의 대사는 attempts에 남는다 (평가가 첫 대사와 최종 대사를 나눠 기록)
    expect(r.attempts[0]?.responseText).toContain("바로 답하기 어려워");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("npc_appraisal");
  });

  it("move를 정하지 않으므로 V4(끝맺음)는 B에 적용되지 않는다: 질문으로 끝나도 거부하지 않는다", async () => {
    live();
    vi.stubGlobal("fetch", vi.fn(async () => body(out("그럼 오늘은 뭐가 제일 서운했어?", []))));
    const r = await appraisalReplyFromFacts(state(), "알았어 기다릴게", facts);
    expect(r.ok && r.reply.checks).toEqual([expect.objectContaining({ attempt: 1, violations: [] })]);
  });

  it("A도 같은 1차 결과로 1차 호출 없이 대사만 만들 수 있다 (평가에서 A·B가 같은 1차 결과를 쓴다)", async () => {
    live();
    const sent: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => (sent.push(init.body), body(JSON.stringify({ beats: [{ type: "dialogue", content: "응, 고마워." }], thought: "조금 풀렸다", refs: [] })))));
    const r = await replyFromFacts(state(), "알았어 기다릴게", facts);
    expect(r.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("\"npc_turn\"");
  });

  it("서비스 경로(npcReply)는 B를 부르지 않는다: 1차 + A 대사만", async () => {
    live();
    const sent: string[] = [];
    const replies = [
      JSON.stringify({ npcLast: [], npcResolved: [], playerNew: [], playerResolved: [], acts: [{ act: "other", quote: "기다릴게", refersTo: "" }], evaluation }),
      JSON.stringify({ beats: [{ type: "dialogue", content: "응." }], thought: "음", refs: [] }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: { body: string }) => (sent.push(init.body), body(replies.shift()!))));
    const r = await npcReply(state(), "알았어 기다릴게");
    expect(r.ok).toBe(true);
    expect(sent.some((s) => s.includes("npc_appraisal"))).toBe(false);
    expect(sent.map((s) => (JSON.parse(s) as { response_format?: { json_schema?: { name?: string } } }).response_format?.json_schema?.name)).toEqual(["turn_facts", "npc_turn"]);
  });
});
