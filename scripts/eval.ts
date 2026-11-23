// 재현 가능한 평가 장치 (docs/dialogue-architecture.md §14.10 1단계).
// 엔진 생성 로직은 바꾸지 않는다. 지금 코드(npcReply · recordTurn · 1차 분석 · V3 판정 · V1 검사)를 그대로 불러
// 고정 입력(scripts/eval/cases.ts)에 돌리고, 지표를 세어 기준선으로 남긴다. DB에는 저장하지 않는다.
//
//   npm run eval                         # 기준선 전체: replay · cross · mind · ledger · scene · offline
//   npm run eval -- replay [--runs 3] [--play yunjae|seoa] [--partner m|f] [--mind default|soft]
//   npm run eval -- cross  [--runs 2]    # 같은 플레이어 말을 다른 연인에게 (H4 기준선)
//   npm run eval -- mind   [--runs 2]    # 같은 대화를 다른 시작 마음으로 (H5 기준선)
//   npm run eval -- ledger [--runs 5]    # 같은 발화를 1차에 반복 (H6 기준선: 기록 일관성·기대 일치)
//   npm run eval -- scene                # V3 판정: 막아야 할 것 / 통과시킬 것 (거름망 미탐 포함)
//   npm run eval -- offline              # V1 반복 검사 사례 (LLM 없음)
//   npm run eval -- v3compare <결과폴더A> <결과폴더B>   # 두 실행의 V3 지표를 연인 설정별로 나란히 (LLM 없음)
//   npm run eval -- rejudge <결과폴더...> [--runs 3]    # 저장된 연인 대사(최종·거부·재시도)를 지금 V3로 다시 판정.
//                                                       # 대사 생성 LLM은 부르지 않는다 (판정 호출만). V3 정확도 검증 전용
//   npm run eval -- appraisal [--runs 3]  # 실험 1: 캐릭터 직접 해석 (docs/appraisal-review.md §14). 같은 발화를 윤재·서아에게,
//                                         # A 기존 엔진 · B 직접 해석(평가 전용 프롬프트)으로. 1차 결과는 A·B가 같이 쓴다.
//                                         # 결과: 가린 비교표 + 정답 키(blind-key.json) + 해석 검토표
//   --label 이름                         # 결과 폴더 이름에 붙임
//
// 비용 보호 (scripts/eval/budget.ts)
//   실행 전에 예정 호출 수와 예상 비용을 보여 준다. 예상이 $0.10을 넘으면 --yes가 있어야 실행한다.
//   --max-usd 0.2     실행당 비용 상한 (주지 않으면 예상의 1.5배, 최소 $0.02). 상한에 닿으면 새 호출을 멈추고
//                     그때까지 모은 결과를 저장한다. 이미 보낸 요청은 멈출 수 없어 상한을 약간 넘을 수 있다.
//   --plan            계획만 보여 주고 실행하지 않는다
//
// 결과: eval-results/<시각>-<label>/ (gitignore)
//   summary.md          사람용 요약 (지표 표)
//   results.json        원자료 전체
//   transcripts/*.md    리플레이 전사본 (대사 품질은 사람이 이걸 보고 판단한다)
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { CallKind } from "./eval/budget.js";
import type { RejudgeItem, SavedRun } from "./eval/rejudge.js";
import { loadEnv } from "./env.js";
loadEnv();

const { npcReply, buildFactsPrompt, parseFacts, FACTS_JSON_SCHEMA, replyRepetitionViolation, NPC_PROMPT_VERSION, replyFromFacts, appraisalReplyFromFacts, ENDS_WITH_QUESTION } = await import("../server/npc.js");
const { newGame, recordTurn, shakePercent } = await import("../server/rules.js");
const { callWithRetry, isScripted } = await import("../server/llm.js");
const { modelConfig } = await import("../server/model-config.js");
const { buildSceneCheckPrompt, parseSceneVerdict, SCENE_JSON_SCHEMA, SCENE_TRIGGERS, sceneTriggers } = await import("../server/checks.js");
const { sceneFactsFor, PARTNERS } = await import("../server/content.js");
const { ledgerLines, applyFacts } = await import("../server/ledger.js");
const C = await import("./eval/cases.js");
const AP = await import("./eval/appraisal.js");
const M = await import("./eval/metrics.js");
const B = await import("./eval/budget.js");
const RJ = await import("./eval/rejudge.js");

type GameState = ReturnType<typeof newGame>;
type Attempt = { usage: { promptTokens: number | null; completionTokens: number | null; cachedTokens?: number | null; cost: number | null } | null; latencyMs: number; result: string; responseText: string | null; respondedModel?: string | null };

// ------------------------------------------------------------------ 인자

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "all";
const opt = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const runsOpt = opt("runs") ? Number(opt("runs")) : undefined;
const label = opt("label") ?? mode;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = `eval-results/${stamp}-${label}`;

const MODES = ["all", "replay", "cross", "mind", "ledger", "scene", "offline", "v3compare", "rejudge", "appraisal"];
if (!MODES.includes(mode)) {
  console.log(`모르는 모드: ${mode} (${MODES.join(", ")})`);
  process.exit(1);
}
const usesLlm = mode !== "offline" && mode !== "v3compare";
if (isScripted() && usesLlm && !argv.includes("--plan")) {
  console.log("OPENROUTER_API_KEY가 없거나 SCRIPTED=1이라 실제 모델을 부르지 않아요. 기준선은 실제 모델로 만들어야 해요 (offline만 가능).");
  process.exit(1);
}

// ------------------------------------------------------------------ 공통

const MODELS = { turn_frame: modelConfig("turn_frame").model, npc_turn: modelConfig("npc_turn").model, scene_check: modelConfig("scene_check").model };
const EST = B.estimatesFor(MODELS);
const TURN = B.turnEstimate(EST);
let budget = new B.Budget(Infinity, EST); // 계획을 세운 뒤 실제 상한으로 바꾼다

const cost = { calls: 0, input: 0, cached: 0, output: 0, usd: 0, byType: {} as Record<string, { calls: number; usd: number; input: number; cached: number; responded: Record<string, number> }> };
function account(type: "turn_frame" | "npc_turn" | "scene_check", attempts: readonly Attempt[]) {
  budget.record(type, attempts);
  for (const a of attempts) {
    const u = a.usage;
    cost.calls++;
    cost.input += u?.promptTokens ?? 0;
    cost.cached += u?.cachedTokens ?? 0;
    cost.output += u?.completionTokens ?? 0;
    cost.usd += u?.cost ?? 0;
    const t = (cost.byType[type] ??= { calls: 0, usd: 0, input: 0, cached: 0, responded: {} });
    t.calls++;
    // 설정한 모델(meta.models)과 따로, 공급자가 실제로 응답한 모델을 센다 (기준선과 비교 조건 확인용)
    const m = a.respondedModel ?? "(응답 없음)";
    t.responded[m] = (t.responded[m] ?? 0) + 1;
    t.usd += u?.cost ?? 0;
    t.input += u?.promptTokens ?? 0;
    t.cached += u?.cachedTokens ?? 0;
  }
}

async function pool<T, R>(items: readonly T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      // 비용 상한에 닿으면 새 작업을 시작하지 않는다 (진행 중인 작업은 끝까지 간다). 시작 못 한 칸은 비어 있다
      while (next < items.length && !budget.stopped) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out.filter((x) => x !== undefined);
}

/** 판정 결과를 사람이 읽을 문자열로. claim(연인이 직접 주장한 것)은 판정 원칙 강화 뒤에만 있다 */
const verdictText = (v: { reason: string; claim?: string }) => (v.claim ? `${v.claim} → ${v.reason}` : v.reason);

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const md: string[] = [];

/** 기준선과 비교할 수 있게 실행 조건을 남긴다 */
function runMeta() {
  const sh = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);
  const judgeTemplate = buildSceneCheckPrompt(["{장면 사실}"], "{이름}", "{플레이어}", "{대사}").system;
  return {
    commit: sh("git rev-parse --short HEAD"),
    dirty: sh("git status --porcelain -- server scripts") !== "",
    promptVersion: NPC_PROMPT_VERSION,
    models: MODELS,
    /** 지금 거름망의 표현 목록 (server/checks.ts SCENE_TRIGGERS) */
    sceneTriggers: SCENE_TRIGGERS.map((t) => t.key),
    judgePromptHash: hash(judgeTemplate),
    casesHash: hash(readFileSync("scripts/eval/cases.ts", "utf8")),
    estimates: EST,
  };
}

const json: Record<string, unknown> = { mode, stamp, meta: runMeta() };
mkdirSync(`${outDir}/transcripts`, { recursive: true });

// ------------------------------------------------------------------ 리플레이

interface TurnResult {
  turn: number;
  player: string;
  ok: boolean;
  failure?: string;
  beats?: { type: "narration" | "dialogue"; content: string }[];
  thought?: string;
  move?: string;
  outcome?: string;
  violations?: string[][];
  sceneTriggers?: string[];
  sceneVerdicts?: string[];
  rejected?: string[];
  refs?: string[];
  question?: boolean;
  motifs?: string[];
  factsRaw?: { items: number; resolves: number; acts: number } | null;
  factsAccepted?: { items: number; resolves: number; acts: number };
  signature?: string;
  resolved?: string[];
  added?: string[];
  applied?: number;
  shake?: number;
  mind?: Record<string, number>;
  /** 대사 호출 시도별 원문 (재판정용). result는 "ok" 또는 거부 이유 */
  attempts?: { attempt: number; result: string; beats: { type: "narration" | "dialogue"; content: string }[] | null }[];
  latencyMs: number;
  usd: number;
}
interface RunResult {
  config: string;
  run: number;
  partner: "m" | "f";
  turns: TurnResult[];
  completed: boolean;
  outcome: string | null;
  shake: number;
  usd: number;
  distinct: number;
  echoMax: number[];
  finalLedger: string;
}

const INITIAL_IDS = new Set(["L1", "L2", "L3"]);

async function replayRun(config: string, play: (typeof C.PLAYS)[number], partner: "m" | "f", mind: keyof typeof C.MIND_VARIANTS, run: number): Promise<RunResult> {
  let s: GameState = newGame(`eval-${config}-${run}-${Date.now()}`, Date.now(), false, partner);
  s = { ...s, currentMind: { ...C.MIND_VARIANTS[mind] } };
  const turns: TurnResult[] = [];
  let usdRun = 0;
  for (const [i, line] of play.lines.entries()) {
    // 한 마디 안의 호출(1차·대사·판정)은 중간에 멈출 수 없으므로, 한 마디의 최대 비용이 상한 안일 때만 시작한다
    if (!budget.allow(TURN.max)) break;
    const t0 = Date.now();
    const r = await npcReply(s, line);
    const latencyMs = Date.now() - t0;
    const usd = [...r.factsAttempts, ...r.attempts, ...r.sceneAttempts].reduce((a, x) => a + (x.usage?.cost ?? 0), 0);
    usdRun += usd;
    account("turn_frame", r.factsAttempts);
    account("npc_turn", r.attempts);
    account("scene_check", r.sceneAttempts);
    if (!r.ok) {
      turns.push({ turn: i + 1, player: line, ok: false, failure: r.failure.message, latencyMs, usd });
      break;
    }
    const known = new Set(s.ledger.map((x) => x.id));
    s = recordTurn(s, { player: line, npc: r.reply.beats, move: r.reply.move, facts: r.reply.facts, thought: r.reply.reason, noticed: r.reply.noticed, suggested: r.reply.suggested, labels: r.reply.labels });
    const t = s.turns.at(-1)!;
    const rejected = r.attempts
      .filter((a) => a.result !== "ok")
      .map((a) => {
        let said = a.responseText ?? "";
        try {
          said = (JSON.parse(said) as { beats: { content: string }[] }).beats.map((b) => b.content).join(" / ");
        } catch {
          /* 형식 오류는 원문 그대로 */
        }
        return `[${a.result.replace("invalid_output:", "")}] ${said}`.slice(0, 400);
      });
    const attempts = r.attempts.map((a) => {
      let beats: TurnResult["beats"] | null = null;
      try {
        beats = (JSON.parse(a.responseText ?? "") as { beats: NonNullable<TurnResult["beats"]> }).beats;
      } catch {
        /* 형식 오류: 대사 없음 */
      }
      return { attempt: a.attempt, result: a.result, beats };
    });
    turns.push({
      turn: i + 1,
      player: line,
      ok: true,
      beats: r.reply.beats,
      thought: r.reply.reason,
      move: r.reply.move,
      outcome: r.reply.outcome,
      violations: r.reply.checks.map((c) => c.violations),
      sceneTriggers: r.reply.checks.flatMap((c) => c.sceneTriggers),
      sceneVerdicts: r.reply.checks.filter((c) => c.sceneVerdict).map((c) => `${c.sceneVerdict!.verdict}: ${c.sceneVerdict!.reason}`),
      rejected,
      attempts,
      refs: r.reply.refs.map((x) => `${x.id}:${x.use}`),
      question: M.hasQuestion(r.reply.beats),
      motifs: M.motifHits(r.reply.beats),
      factsRaw: M.rawFactsCounts(r.factsAttempts.at(-1)?.responseText ?? null),
      factsAccepted: M.acceptedFactsCounts(r.reply.facts),
      signature: M.factsSignature(r.reply.facts, INITIAL_IDS),
      resolved: r.reply.facts.resolved.map((x) => `${x.id} ${x.status} (${x.by}: “${x.quote}”)`),
      added: r.reply.facts.added.map((x) => `${x.id}[${x.by}·${x.kind}] ${x.text}`),
      applied: t.applied,
      shake: shakePercent(s.score),
      mind: { ...s.currentMind },
      latencyMs,
      usd,
    });
    void known;
  }
  const lines = turns.filter((t) => t.ok).map((t) => M.dialogueOf(t.beats!));
  const result: RunResult = {
    config,
    run,
    partner,
    turns,
    completed: turns.length === play.lines.length && turns.every((t) => t.ok),
    outcome: s.outcome,
    shake: shakePercent(s.score),
    usd: usdRun,
    distinct: M.distinctRatio(lines),
    echoMax: M.echoOverlaps(lines),
    finalLedger: ledgerLines(s.ledger, "neutral"),
  };
  writeTranscript(result, play, mind);
  return result;
}

function writeTranscript(r: RunResult, play: (typeof C.PLAYS)[number], mind: string) {
  const name = PARTNERS[r.partner].name;
  const out = [`# ${r.config} · 실행 ${r.run + 1}`, "", `- 원래 판: ${play.source} · 연인: ${name} · 시작 마음: ${mind} · 프롬프트 ${NPC_PROMPT_VERSION}`, `- 결과: ${r.outcome ?? "(미완료)"} · ${r.shake}% · $${r.usd.toFixed(4)}`, ""];
  for (const t of r.turns) {
    out.push(`## ${t.turn}. 나: ${t.player}`, "");
    if (!t.ok) {
      out.push(`(생성 실패: ${t.failure})`, "");
      continue;
    }
    for (const b of t.beats!) out.push(b.type === "narration" ? `*${b.content}*` : `**${name}:** ${b.content}`, "");
    out.push(
      `> 속마음: ${t.thought}`,
      `> 끝맺음(move): ${t.move} · 검증: ${t.outcome}${t.violations!.some((v) => v.length) ? ` (${t.violations!.map((v) => v.join("|") || "통과").join(" → ")})` : ""} · refs: ${t.refs!.join(", ") || "없음"}`,
      `> +${t.applied} → ${t.shake}% · 마음 ${Object.entries(t.mind!).map(([k, v]) => `${k} ${v}`).join(", ")}`,
      ...(t.resolved!.length ? [`> 정리: ${t.resolved!.join(" / ")}`] : []),
      ...(t.added!.length ? [`> 새 항목: ${t.added!.join(" / ")}`] : []),
      ...(t.sceneVerdicts!.length ? [`> V3: ${t.sceneTriggers!.join(",")} → ${t.sceneVerdicts!.join(" / ")}`] : []),
      ...(t.rejected!.length ? [`> 거부된 시도: ${t.rejected!.join(" || ")}`] : []),
      "",
    );
  }
  out.push("## 최종 장부", "", "```", r.finalLedger, "```", "");
  writeFileSync(`${outDir}/transcripts/${r.config}-run${r.run + 1}.md`, out.join("\n"));
}

/** 연인 설정별 V3 지표. 노출(exposed)은 판정 결과일 뿐 실제 오류 수가 아니다 (사람 검토로 확인). */
function v3Rows(results: readonly RunResult[]) {
  const configs = [...new Set(results.map((r) => r.config))];
  return configs.map((c) => {
    const ts = results.filter((r) => r.config === c).flatMap((r) => r.turns.filter((t) => t.ok));
    const judged = ts.filter((t) => (t.sceneVerdicts ?? []).length);
    return {
      config: c,
      turns: ts.length,
      triggered: ts.filter((t) => (t.sceneTriggers ?? []).length).length,
      judgeCalls: ts.reduce((a, t) => a + (t.sceneVerdicts ?? []).length, 0),
      sceneRejects: ts.reduce((a, t) => a + (t.violations ?? []).filter((v) => v.some((x) => x.startsWith("scene_contradiction"))).length, 0),
      prevented: ts.filter((t) => t.outcome === "prevented").length,
      exposed: ts.filter((t) => t.outcome === "exposed").length,
      judgedLatency: judged.length ? judged.reduce((a, t) => a + t.latencyMs, 0) / judged.length / 1000 : 0,
      latency: ts.length ? ts.reduce((a, t) => a + t.latencyMs, 0) / ts.length / 1000 : 0,
      usd: ts.reduce((a, t) => a + t.usd, 0),
    };
  });
}
function v3Table(results: readonly RunResult[]): string[] {
  return [
    "| 설정 | 마디 | 거름망 걸린 마디 | 판정 호출 | V3 거부 | prevented | exposed(판정상) | 판정 있는 마디 평균 시간 | 전체 평균 시간 | 비용 합 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...v3Rows(results).map((r) => `| ${r.config} | ${r.turns} | ${r.triggered} | ${r.judgeCalls} | ${r.sceneRejects} | ${r.prevented} | ${r.exposed} | ${r.judgedLatency.toFixed(1)}초 | ${r.latency.toFixed(1)}초 | $${r.usd.toFixed(4)} |`),
  ];
}

function summarizeReplay(title: string, results: RunResult[]) {
  md.push(`## ${title}`, "");
  const configs = [...new Set(results.map((r) => r.config))];
  md.push("| 설정 | 실행 | 완주 | 결과 분포 | 움직인 % | 판당 비용 | 대사 다양성(서로 다른 2-gram 비율) |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const c of configs) {
    const rs = results.filter((r) => r.config === c);
    const outcomes = Object.entries(rs.reduce((a, r) => ((a[r.outcome ?? "미완료"] = (a[r.outcome ?? "미완료"] ?? 0) + 1), a), {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(", ");
    md.push(`| ${c} | ${rs.length} | ${rs.filter((r) => r.completed).length} | ${outcomes} | ${M.fmt(M.summarize(rs.map((r) => r.shake)), 1)} | $${M.fmt(M.summarize(rs.map((r) => r.usd)), 4)} | ${M.fmt(M.summarize(rs.map((r) => r.distinct)))} |`);
  }
  md.push("");

  const turns = results.flatMap((r) => r.turns.filter((t) => t.ok).map((t) => ({ ...t, config: r.config, last: t.turn === 5 })));
  const n = turns.length;
  const q = turns.filter((t) => t.question);
  md.push("### 질문 빈도 (질문 상한 결정의 기준선, §14.3)", "");
  md.push(`- 질문으로 끝나는 대사가 있는 마디: ${q.length} / ${n} (${pct(q.length, n)})`);
  md.push(`- 마디 번호별: ${[1, 2, 3, 4, 5].map((k) => `${k}마디 ${pct(turns.filter((t) => t.turn === k && t.question).length, turns.filter((t) => t.turn === k).length)}`).join(" · ")}`);
  md.push(`- 판당 질문 마디 수: ${M.fmt(M.summarize(results.map((r) => r.turns.filter((t) => t.ok && t.question).length)), 1)}`);
  const moves = turns.reduce((a, t) => ((a[t.move!] = (a[t.move!] ?? 0) + 1), a), {} as Record<string, number>);
  md.push(`- 끝맺음(move) 분포: ${Object.entries(moves).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");

  md.push("### 반복 표현", "");
  for (const m of M.MOTIFS) md.push(`- ${m.key}: ${pct(turns.filter((t) => t.motifs!.includes(m.key)).length, n)} 마디`);
  const echo = results.flatMap((r) => r.echoMax.slice(1));
  md.push(`- 앞의 연인 대사 중 하나와 2-gram이 60% 이상 겹친 대사: ${echo.filter((x) => x >= 0.6).length} / ${echo.length}`, `- 앞 대사와의 최대 겹침: ${M.fmt(M.summarize(echo))}`, "");

  md.push("### 검증 결과", "");
  const outc = turns.reduce((a, t) => ((a[t.outcome!] = (a[t.outcome!] ?? 0) + 1), a), {} as Record<string, number>);
  md.push(`- 분류: ${Object.entries(outc).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  const viol = turns.flatMap((t) => t.violations!.flat()).reduce((a, v) => ((a[v.split(":")[0]!] = (a[v.split(":")[0]!] ?? 0) + 1), a), {} as Record<string, number>);
  md.push(`- 위반 종류(시도 기준): ${Object.entries(viol).map(([k, v]) => `${k} ${v}`).join(", ") || "없음"}`);
  const trig = turns.flatMap((t) => t.sceneTriggers!).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {} as Record<string, number>);
  md.push(`- V3 거름망: ${Object.entries(trig).map(([k, v]) => `${k} ${v}`).join(", ") || "없음"} · 판정 ${turns.reduce((a, t) => a + t.sceneVerdicts!.length, 0)}회`);
  md.push(`- 생성 실패로 끝난 마디: ${results.flatMap((r) => r.turns.filter((t) => !t.ok)).length}`, "");

  md.push("#### V3 설정별 (exposed는 판정 결과일 뿐 실제 오류 수가 아니다. 사람 검토로 확인)", "", ...v3Table(results), "");

  md.push("### 장부 기록", "");
  const raw = turns.filter((t) => t.factsRaw);
  const dropped = raw.reduce((a, t) => a + Math.max(0, t.factsRaw!.items - t.factsAccepted!.items) + Math.max(0, t.factsRaw!.resolves - t.factsAccepted!.resolves), 0);
  md.push(`- 1차가 낸 항목·정리 중 검증에서 버려진 수: ${dropped} (마디 ${raw.length}개 합) — 중복으로 버려진 것도 포함`);
  md.push("- 같은 마디의 기록이 실행마다 같은가 (장면 시작 항목의 정리 + 발화 행위 + 새 항목 종류):", "");
  md.push("| 설정 | 마디 | 일치율 | 가장 흔한 기록 |", "| --- | --- | --- | --- |");
  for (const c of configs)
    for (const k of [1, 2, 3, 4, 5]) {
      const sigs = turns.filter((t) => t.config === c && t.turn === k).map((t) => t.signature!);
      if (sigs.length < 2) continue;
      const a = M.agreement(sigs);
      md.push(`| ${c} | ${k} | ${pct(a.rate * sigs.length, sigs.length)} (${sigs.length}회) | \`${a.modal}\` |`);
    }
  md.push("");

  md.push("### 시간", "");
  const lat = turns.map((t) => t.latencyMs / 1000);
  md.push(`- 마디당 응답 시간(초): ${M.fmt(M.summarize(lat), 1)}`, "");
}

async function runReplay(configs: { config: string; play: (typeof C.PLAYS)[number]; partner: "m" | "f"; mind: keyof typeof C.MIND_VARIANTS }[], runs: number, title: string) {
  const jobs = configs.flatMap((c) => Array.from({ length: runs }, (_, run) => ({ ...c, run })));
  console.log(`· ${title}: ${jobs.length}판`);
  const results = await pool(jobs, 3, (j) => replayRun(j.config, j.play, j.partner, j.mind, j.run));
  summarizeReplay(title, results);
  return results;
}

// ------------------------------------------------------------------ 장부 기록 일관성 (1차만)

async function runLedger(runs: number) {
  console.log(`· ledger: 사례 ${C.LEDGER_CASES.length}개 × ${runs}회`);
  md.push("## 장부 기록 일관성 (1차 발화 분석만, H6 기준선)", "", "같은 입력을 여러 번 분석해 기록이 같은지, 설계 §14.4의 기대와 맞는지 본다. 지금 코드가 기대를 못 맞추는 것도 기준선으로 그대로 남긴다.", "");
  md.push("| 사례 | 확인하는 것 | 기대 일치 | 기록 일치율 | 버려진 항목 | 가장 흔한 기록 | 연결만 (refersTo) | 버린 이유 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  const out: unknown[] = [];
  for (const cs of C.LEDGER_CASES) {
    let s: GameState = newGame(`eval-ledger-${cs.key}`, Date.now(), false, cs.partner);
    for (const p of cs.prefix) s = recordTurn(s, { player: p.player, npc: p.npc, move: "counter", ...(p.facts ? { facts: p.facts } : {}), suggested: 0, labels: [] });
    const known = new Set(s.ledger.map((x) => x.id));
    const one = async () => {
      if (!budget.allow(EST.turn_frame)) return { ok: false as const, failure: `budget: ${budget.stopped}` };
      const prompt = buildFactsPrompt(s, cs.player);
      const res = await callWithRetry(modelConfig("turn_frame"), { ...prompt, schemaName: "turn_facts", schema: FACTS_JSON_SCHEMA }, (j, a) => parseFacts(s, cs.player, j, !a.last));
      account("turn_frame", res.attempts);
      if (!res.ok) return { ok: false as const, failure: res.failure.message };
      const f = res.value;
      const acts = f.acts.map((a) => a.act);
      const misses: string[] = [];
      for (const a of cs.expect.actsInclude ?? []) if (!acts.includes(a)) misses.push(`acts에 ${a} 없음`);
      for (const a of cs.expect.actsExclude ?? []) if (acts.includes(a)) misses.push(`acts에 ${a} 있음`);
      for (const r of cs.expect.resolves ?? []) if (!f.resolved.some((x) => x.id === r.id && x.status === r.status)) misses.push(`${r.id} ${r.status} 아님`);
      for (const id of cs.expect.keepsOpen ?? []) if (f.resolved.some((x) => x.id === id)) misses.push(`${id}가 정리됨`);
      for (const by of cs.expect.noResolutionsBy ?? []) for (const r of f.resolved.filter((x) => x.by === by)) misses.push(`${by === "player" ? "플레이어" : "연인"}가 ${known.has(r.id) ? r.id : "새 항목"} ${r.status}`);
      for (const k of cs.expect.playerNewKindsInclude ?? []) if (!f.added.some((x) => x.by === "player" && x.kind === k)) misses.push(`플레이어 ${k} 없음`);
      for (const k of cs.expect.npcLastKindsExclude ?? []) if (f.added.some((x) => x.by === "npc" && x.kind === k)) misses.push(`연인 ${k} 있음`);
      const raw = M.rawFactsCounts(res.attempts.at(-1)?.responseText ?? null);
      const acc = M.acceptedFactsCounts(f);
      return {
        ok: true as const,
        signature: M.factsSignature(f, known),
        misses,
        dropped: raw ? Math.max(0, raw.items - acc.items) + Math.max(0, raw.resolves - acc.resolves) : null,
        // 검증에서 버린 것의 이유 (TurnFacts.dropped, 진단용). 앞의 dropped(개수)는 기준선과 같은 정의라 그대로 둔다
        droppedWhy: f.dropped ?? [],
        // 정리하지 않고 연결만 한 것 (결정 1의 "연결만"이 실제로 쓰이는지)
        links: f.acts.filter((x) => x.refersTo).map((x) => `${x.act}→${known.has(x.refersTo) ? x.refersTo : "새"}`),
        facts: f,
      };
    };
    const rs = await pool(Array.from({ length: runs }), 3, one);
    const oks = rs.filter((r) => r.ok) as Extract<(typeof rs)[number], { ok: true }>[];
    const a = M.agreement(oks.map((r) => r.signature));
    const pass = oks.filter((r) => r.misses.length === 0).length;
    const missTally = Object.entries(oks.flatMap((r) => r.misses).reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k}×${v}`).join(", ");
    const tally = (xs: string[]) => Object.entries(xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k}×${v}`).join(", ") || "-";
    const links = tally(oks.flatMap((r) => r.links));
    // 이유의 종류만 센다 (내용은 results.json의 droppedWhy)
    const why = tally(oks.flatMap((r) => r.droppedWhy.map((w) => w.split(":")[0]!)));
    md.push(`| ${cs.key} | ${cs.about} | ${pass}/${oks.length}${missTally ? ` (${missTally})` : ""} | ${pct(a.rate * oks.length, oks.length)} | ${oks.reduce((x, r) => x + (r.dropped ?? 0), 0)} | \`${a.modal}\` | ${links} | ${why} |`);
    out.push({ case: cs.key, results: rs });
  }
  md.push("");
  json.ledger = out;
}

// ------------------------------------------------------------------ 실험 1: 캐릭터 직접 해석 (docs/appraisal-review.md §14)

async function runAppraisal(runs: number) {
  const partners = ["m", "f"] as const;
  console.log(`· appraisal: 발화 ${C.APPRAISAL_LINES.length}개 × 연인 2 × 조건 2 × ${runs}회`);
  // 가린 비교표의 섞기 순서 (결과에 남겨 다시 만들 수 있게)
  const seed = parseInt(createHash("sha256").update(stamp).digest("hex").slice(0, 8), 16);
  const cells: import("./eval/appraisal.js").Cell[] = [];
  type Gen = import("./eval/appraisal.js").Gen;
  for (const [idx, item] of C.APPRAISAL_LINES.entries()) {
    for (const partner of partners) {
      if (budget.stopped) break;
      const s = recordTurn(newGame(`eval-appraisal-${idx}-${partner}`, Date.now(), false, partner), {
        player: C.APPRAISAL_PREFIX.player,
        npc: [{ type: "dialogue", content: C.APPRAISAL_PREFIX.npc }],
        move: "counter",
        suggested: 0,
        labels: [],
      });
      const cell: (typeof cells)[number] = { idx, line: item.line, about: item.about, partner, name: PARTNERS[partner].name, gens: [] };
      cells.push(cell);
      // 1차는 한 번만: A·B와 모든 반복이 같은 객관 기록을 쓴다
      if (!budget.allow(EST.turn_frame)) {
        cell.factsFailure = `budget: ${budget.stopped}`;
        continue;
      }
      const fr = await callWithRetry(modelConfig("turn_frame"), { ...buildFactsPrompt(s, item.line), schemaName: "turn_facts", schema: FACTS_JSON_SCHEMA }, (j, a) => parseFacts(s, item.line, j, !a.last));
      account("turn_frame", fr.attempts);
      if (!fr.ok) {
        cell.factsFailure = fr.failure.message;
        continue;
      }
      const facts = fr.value;
      const ledgerAfter = applyFacts(s.ledger, facts, s.turns.length + 1);
      const who = (b: string) => (b === "player" ? "플레이어" : "연인");
      cell.factsSummary = [
        `정리: ${facts.resolved.map((r) => `${r.id} ${who(r.by)} ${r.status} “${r.quote}”`).join(", ") || "없음"}`,
        `새 항목: ${facts.added.map((a) => `${a.id} ${who(a.by)} ${a.kind} “${a.quote}”`).join(", ") || "없음"}`,
        `발화 행위(A에만 보임): ${facts.acts.map((a) => `${a.act}${a.refersTo ? `→${a.refersTo}` : ""}`).join(", ")}`,
        ...(facts.dropped?.length ? [`버린 것 ${facts.dropped.length}`] : []),
      ].join(" · ");
      // V2가 막았다면 근거: 그 항목이 왜 정리 상태였나 (1차가 어떤 인용으로 기록했나)
      const v2Hits = (checks: readonly { attempt: number; violations: string[] }[]) =>
        checks.flatMap((c) =>
          c.violations
            .filter((v) => v.startsWith("reasserts_resolved:"))
            .flatMap((v) =>
              v.slice("reasserts_resolved:".length).split(",").map((id) => {
                const it = ledgerAfter.find((x) => x.id === id);
                return { attempt: c.attempt, id, text: it?.text ?? "?", resolvedBy: it?.resolvedBy ? `${who(it.resolvedBy.by)}${it.resolvedBy.by === "player" ? "가" : "이"} ${it.resolvedBy.turn}마디에 “${it.resolvedBy.quote}” → ${it.status}` : "(정리 기록 없음)" };
              }),
            ),
        );
      const endsQ = (beats: readonly { type: string; content: string }[]) => ENDS_WITH_QUESTION.test((beats.filter((b) => b.type === "dialogue").at(-1)?.content ?? "").trim());
      const jobs = (["A", "B"] as const).flatMap((cond) => Array.from({ length: runs }, (_, i) => ({ cond, run: i + 1 })));
      cell.gens = await pool(jobs, 4, async (job): Promise<Gen> => {
        const fail = (failure: string, drafts: Gen["drafts"] = []): Gen => ({ cond: job.cond, run: job.run, ok: false, failure, drafts, refs: [], v2: [] });
        if (!budget.allow(APPRAISAL_GEN.max)) return fail(`budget: ${budget.stopped}`);
        if (job.cond === "A") {
          const r = await replyFromFacts(s, item.line, facts);
          account("npc_turn", r.attempts);
          account("scene_check", r.sceneAttempts);
          if (!r.ok) return fail(r.failure.message, AP.draftsFrom(r.attempts, []));
          return {
            cond: "A",
            run: job.run,
            ok: true,
            drafts: AP.draftsFrom(r.attempts, r.reply.checks),
            final: r.reply.beats,
            outcome: r.reply.outcome,
            move: r.reply.move,
            endsWithQuestion: endsQ(r.reply.beats),
            thought: r.reply.reason,
            refs: r.reply.refs.map((x) => `${x.id}:${x.use}`),
            v2: v2Hits(r.reply.checks),
          };
        }
        const r = await appraisalReplyFromFacts(s, item.line, facts);
        account("npc_turn", r.attempts);
        account("scene_check", r.sceneAttempts);
        if (!r.ok) return fail(r.failure.message, AP.draftsFrom(r.attempts, []));
        return {
          cond: "B",
          run: job.run,
          ok: true,
          drafts: AP.draftsFrom(r.attempts, r.reply.checks),
          final: r.reply.beats,
          outcome: r.reply.outcome,
          endsWithQuestion: r.reply.endsWithQuestion,
          heard: r.reply.heard,
          shift: r.reply.shift,
          want: r.reply.want,
          refs: r.reply.refs.map((x) => `${x.id}:${x.use}`),
          v2: v2Hits(r.reply.checks),
        };
      });
      cell.gens.sort((a, b) => (a.cond === b.cond ? a.run - b.run : a.cond < b.cond ? -1 : 1));
      console.log(`  ${idx + 1}. ${cell.name}: ${cell.gens.filter((g) => g.ok).length}/${jobs.length}`);
    }
  }

  const blind = AP.blindSheet(cells, seed);
  writeFileSync(`${outDir}/transcripts/appraisal-blind.md`, blind.md);
  // 정답 키는 전사본 폴더 밖에 따로 둔다 (가린 비교를 마친 뒤에 연다)
  writeFileSync(`${outDir}/blind-key.json`, JSON.stringify({ seed, key: blind.key }, null, 2));
  writeFileSync(`${outDir}/transcripts/appraisal-review.md`, AP.reviewSheet(cells));
  md.push(
    "## 실험 1: 캐릭터 직접 해석",
    "",
    "- **A 기존 엔진:** 지금 서비스와 같은 대사 프롬프트 (BAND·1차의 의미 라벨·장부 상태어·끝맺음을 생성 전에 정함)",
    "- **B 직접 해석:** 평가 전용 프롬프트. 원문·실제로 말해진 것·Core·듣기 전 마음만. heard → shift → want → 대사. 끝맺음은 정하지 않는다 (V4 해당 없음). 서비스 생성 로직은 바꾸지 않았다",
    `- 같게 둔 것: 모델 · 1차 결과(발화·연인마다 1회, A·B 공통) · 앞 대화 1마디("${C.APPRAISAL_PREFIX.player}" → "${C.APPRAISAL_PREFIX.npc}") · 시작 마음 · V1~V3`,
    "- **한계:** A와 B는 라벨 제거·BAND 제거·출력 구조·끝맺음 강제 여부가 함께 다르다. 어느 변경이 원인인지는 이 실험으로 가를 수 없다 (탐색 실험). 표본이 작다",
    `- 사람 검토: \`transcripts/appraisal-blind.md\`(가린 비교, 먼저) → \`blind-key.json\`(정답 키) → \`transcripts/appraisal-review.md\`(해석 검토) · 섞기 시드 ${seed}`,
    "",
    ...AP.summaryLines(cells),
  );
  json.appraisal = { seed, prefix: C.APPRAISAL_PREFIX, lines: C.APPRAISAL_LINES, cells };
}

// ------------------------------------------------------------------ V3 장면 판정

async function runScene(runs: number) {
  console.log(`· scene: ${C.SCENE_CASES.length}줄 × ${runs}회`);
  md.push(
    "## V3 장면 판정",
    "",
    `실제 서비스는 거름망에 걸린 대사만 판정한다. 여기서는 판정 자체의 정확도도 보려고 모든 줄을 판정한다. 판정은 실행마다 흔들리므로 줄마다 ${runs}회 판정해 비율로 본다.`,
    "",
  );
  md.push("| 기대 | 대사 | 거름망 | 판정 (contradiction 비율) | 실제 서비스가 막은 비율 | 출처 · 메모 |", "| --- | --- | --- | --- | --- | --- |");
  const jobs = C.SCENE_CASES.flatMap((sc) => Array.from({ length: runs }, () => sc));
  const all = await pool(jobs, 4, async (sc) => {
    if (!budget.allow(EST.scene_check)) return null;
    const triggers = sceneTriggers(sc.line);
    const p = buildSceneCheckPrompt(sceneFactsFor("m"), PARTNERS.m.name, sc.player, sc.line);
    const t0 = Date.now();
    const res = await callWithRetry(modelConfig("scene_check"), { ...p, schemaName: "scene_check", schema: SCENE_JSON_SCHEMA }, (j) => parseSceneVerdict(j));
    account("scene_check", res.attempts);
    const verdict = res.ok ? res.value.verdict : "unclear";
    const service = triggers.length ? (verdict === "contradiction" ? "막음" : "통과") : "통과(거름망 밖)";
    return { ...sc, triggers, verdict, failed: !res.ok, reason: res.ok ? verdictText(res.value) : res.failure.message, service, latencyMs: Date.now() - t0 };
  });
  // 판정 호출 자체가 실패한 것(키 한도 등)은 정확도 계산에서 뺀다
  const failed = all.filter((r) => r?.failed).length;
  const rows = all.filter((r): r is NonNullable<typeof r> => Boolean(r && !r.failed));
  if (failed) md.push(`> ⚠️ 판정 호출 실패 ${failed}회는 집계에서 뺐다.`, "");
  for (const sc of C.SCENE_CASES) {
    const rs = rows.filter((r) => r.line === sc.line && r.player === sc.player);
    if (!rs.length) continue;
    const contra = rs.filter((r) => r.verdict === "contradiction").length;
    const blocked = rs.filter((r) => r.service === "막음").length;
    const right = sc.expect === "contradiction" ? blocked === rs.length : blocked === 0;
    const reasons = [...new Set(rs.map((r) => `${r.verdict}: ${r.reason}`))].slice(0, 2).join(" / ");
    md.push(`| ${sc.expect}${right ? "" : " ✗"} | ${sc.line} | ${rs[0]!.triggers.join(",") || "-"} | ${contra}/${rs.length} (${reasons}) | ${blocked}/${rs.length} | ${sc.source}${sc.note ? ` · ${sc.note}` : ""} |`);
  }
  md.push("");
  const SRC = { real: "실제 대화에서 나온 사례", design: "설계 대표 사례", synthetic: "합성 미탐 확인 사례" } as const;
  for (const src of ["real", "design", "synthetic"] as const) {
    const sub = rows.filter((r) => r.source === src);
    if (!sub.length) continue;
    const mustCatch = sub.filter((r) => r.expect === "contradiction");
    const mustPass = sub.filter((r) => r.expect === "ok");
    md.push(
      `**${SRC[src]}** (판정 횟수 기준)`,
      `- 미탐: 막아야 할 판정 ${mustCatch.length}회 중 실제 서비스가 놓침 ${mustCatch.filter((r) => r.service !== "막음").length} (거름망 밖 ${mustCatch.filter((r) => !r.triggers.length).length}, 판정이 놓침 ${mustCatch.filter((r) => r.triggers.length && r.verdict !== "contradiction").length})`,
      `- 오탐: 통과시켜야 할 판정 ${mustPass.length}회 중 실제 서비스가 막음 ${mustPass.filter((r) => r.service === "막음").length}`,
      `- 판정만 보면 정확: ${sub.filter((r) => (r.expect === "contradiction") === (r.verdict === "contradiction")).length}/${sub.length}`,
      "",
    );
  }
  md.push(`- 판정 호출 평균 시간: ${M.fmt(M.summarize(rows.map((r) => r.latencyMs / 1000)), 2)}초`, "");
  json.scene = rows;
}

// ------------------------------------------------------------------ V1 반복 검사 (LLM 없음)

function runOffline() {
  console.log(`· offline: V1 사례 ${C.REPETITION_CASES.length}개`);
  md.push("## V1 반복 검사 사례 (LLM 없음)", "", "| 기대 | 직전 연인 말 | 플레이어 | 새 대사 | 지금 결과 | 메모 |", "| --- | --- | --- | --- | --- | --- |");
  const rows = C.REPETITION_CASES.map((c) => {
    const s = recordTurn(newGame("eval-v1", Date.now(), false), { player: "앞 마디", npc: [{ type: "dialogue", content: c.prevNpc }], suggested: 0, labels: [] });
    const v = replyRepetitionViolation(s, [{ type: "dialogue", content: c.candidate }], c.player);
    return { ...c, result: v ? "block" : "allow" };
  });
  for (const r of rows) md.push(`| ${r.expect} | ${r.prevNpc} | ${r.player} | ${r.candidate} | ${r.result}${r.result !== r.expect ? " ✗" : ""} | ${r.note} |`);
  md.push("", `- 기대와 다른 결과: ${rows.filter((r) => r.result !== r.expect).length}/${rows.length}`, "");
  json.offline = rows;
}

// ------------------------------------------------------------------ V3 재판정 (저장된 대사, 대사 생성 LLM 없음)

interface RejudgeJob {
  item: RejudgeItem;
  human: "contradiction" | "ok" | undefined;
  newTriggers: string[];
}

/** 저장된 결과 폴더들에서 판정할 대사를 고른다: 새 거름망에 걸린 것 + 사람이 검토한 것 (서비스 결과와 판정 정확도를 같이 보려고) */
function loadRejudge(dirs: readonly string[]) {
  const names = { m: PARTNERS.m.name, f: PARTNERS.f.name };
  const items: RejudgeItem[] = [];
  for (const d of dirs) {
    const j = JSON.parse(readFileSync(`${d}/results.json`, "utf8")) as { replay?: SavedRun[]; cross?: SavedRun[]; mind?: SavedRun[] };
    items.push(...RJ.extractItems([...(j.replay ?? []), ...(j.cross ?? []), ...(j.mind ?? [])], names, d.split("/").pop() ?? d));
  }
  const jobs = new Map<string, RejudgeJob>();
  for (const it of items) {
    if (jobs.has(it.key)) continue;
    jobs.set(it.key, { item: it, human: RJ.humanLabel(it.dialogue, it.player, C.SCENE_CASES), newTriggers: sceneTriggers(it.dialogue) });
  }
  const toJudge = [...jobs.values()].filter((j) => j.newTriggers.length || j.human);
  return { items, jobs, toJudge };
}

async function runRejudge(dirs: readonly string[], runs: number, data: ReturnType<typeof loadRejudge>) {
  const { items, jobs, toJudge } = data;
  console.log(`· rejudge: 대사 ${items.length}개 (고유 ${jobs.size}) 중 ${toJudge.length}개 × ${runs}회 판정`);
  md.push(
    "## V3 재판정 (저장된 대사, 대사 생성 없음)",
    "",
    `- 원자료: ${dirs.join(", ")} (덮어쓰지 않음)`,
    `- 꺼낸 대사 ${items.length}개 (최종 ${items.filter((x) => x.role === "final").length} · 거부된 시도 ${items.filter((x) => x.role === "rejected").length}, 고유 ${jobs.size}). 판정한 것: 새 거름망에 걸린 대사 + 사람이 검토한 대사 = 고유 ${toJudge.length}개 × ${runs}회`,
    "- **용도는 V3 판정 정확도 검증뿐이다.** 판정이 달라졌을 때 재생성될 대사가 더 자연스러운지는 이걸로 알 수 없다.",
    "- 예전 결과는 거부된 시도의 대사·행동이 섞여 있어, 이름으로 시작하는 조각을 행동 묘사로 보고 뺐다 (추정, 표의 *표시).",
    "- '이전'은 기록된 실제 결과(그때의 거름망·판정), '새'는 지금 코드의 거름망·판정이다.",
    "",
  );
  const jobsN = toJudge.flatMap((j) => Array.from({ length: runs }, () => j));
  const verdicts = new Map<string, { verdict: string; reason: string }[]>();
  let failed = 0;
  await pool(jobsN, 4, async (j) => {
    if (!budget.allow(EST.scene_check)) return null;
    const it = j.item;
    const p = buildSceneCheckPrompt(sceneFactsFor(it.partner), PARTNERS[it.partner].name, it.player, it.dialogue);
    const res = await callWithRetry(modelConfig("scene_check"), { ...p, schemaName: "scene_check", schema: SCENE_JSON_SCHEMA }, (x) => parseSceneVerdict(x));
    account("scene_check", res.attempts);
    if (!res.ok) {
      failed++;
      return null;
    }
    const v = verdicts.get(it.key) ?? [];
    v.push({ verdict: res.value.verdict, reason: verdictText(res.value) });
    verdicts.set(it.key, v);
    return null;
  });
  if (failed) md.push(`> ⚠️ 판정 호출 실패 ${failed}회는 집계에서 뺐다.`, "");

  /** 새 서비스가 이 대사를 막는 비율 (거름망에 안 걸리면 0) */
  const newBlockRate = (j: RejudgeJob) => {
    const vs = verdicts.get(j.item.key) ?? [];
    if (!j.newTriggers.length) return 0;
    return vs.length ? vs.filter((v) => v.verdict === "contradiction").length / vs.length : NaN;
  };
  const occ = (key: string) => items.filter((x) => x.key === key);

  // 1) 사람이 검토한 대사: 이전 vs 새
  md.push("### 사람이 검토한 대사: 이전 결과와 새 결과", "", "| 사람 판단 | 대사 | 등장 | 이전 서비스 | 새 거름망 | 새 판정 (모순 비율) | 새 서비스가 막는 비율 | 판정 이유 예 |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  let oldFP = 0, oldFN = 0, newFP = 0, newFN = 0, okN = 0, conN = 0;
  for (const j of toJudge.filter((x) => x.human)) {
    const os = occ(j.item.key);
    const vs = verdicts.get(j.item.key) ?? [];
    const rate = newBlockRate(j);
    const oldBlocked = os.filter((x) => x.oldService === "막음").length;
    if (j.human === "ok") {
      okN += os.length;
      oldFP += oldBlocked;
      newFP += os.length * (Number.isNaN(rate) ? 0 : rate);
    } else {
      conN += os.length;
      oldFN += os.length - oldBlocked;
      newFN += os.length * (Number.isNaN(rate) ? 1 : 1 - rate);
    }
    md.push(
      `| ${j.human} | ${j.item.dialogue}${os.some((x) => x.heuristic) ? " *" : ""} | ${os.length} | ${[...new Set(os.map((x) => x.oldService))].join(", ")} | ${j.newTriggers.join(",") || "-"} | ${vs.filter((v) => v.verdict === "contradiction").length}/${vs.length} | ${Number.isNaN(rate) ? "-" : `${(rate * 100).toFixed(0)}%`} | ${vs[0]?.reason ?? ""} |`,
    );
  }
  md.push(
    "",
    `- **오탐 (사람: 정상인데 막음)**: 이전 ${oldFP}/${okN}회 → 새 ${newFP.toFixed(1)}/${okN}회 (새 값은 판정 ${runs}회의 평균)`,
    `- **미탐 (사람: 모순인데 통과)**: 이전 ${oldFN}/${conN}회 → 새 ${newFN.toFixed(1)}/${conN}회`,
    "",
  );

  // 2) 사람이 검토하지 않은 대사 중 결과가 바뀐 것: 사람 확인 필요
  const changed = toJudge.filter((j) => !j.human).map((j) => {
    const os = occ(j.item.key);
    const rate = newBlockRate(j);
    const oldBlocked = os.some((x) => x.oldService === "막음");
    return { j, os, rate, oldBlocked };
  }).filter((x) => (x.oldBlocked && x.rate < 0.5) || (!x.oldBlocked && x.rate >= 0.5));
  md.push("### 사람이 검토하지 않았고 결과가 바뀐 대사 (사람 확인 필요)", "");
  if (!changed.length) md.push("- 없음", "");
  else {
    md.push("| 대사 | 플레이어 말 | 이전 서비스 | 새 거름망 | 새 서비스가 막는 비율 | 판정 이유 예 | 위치 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const x of changed) md.push(`| ${x.j.item.dialogue}${x.os.some((o) => o.heuristic) ? " *" : ""} | ${x.j.item.player} | ${[...new Set(x.os.map((o) => o.oldService))].join(", ")} | ${x.j.newTriggers.join(",")} | ${(x.rate * 100).toFixed(0)}% | ${(verdicts.get(x.j.item.key) ?? [])[0]?.reason ?? ""} | ${x.os[0]!.where} |`);
    md.push("");
  }

  // 3) 거름망 변화
  const newlyTriggered = [...jobs.values()].filter((j) => j.newTriggers.length && !RJ.oldTriggers(j.item.dialogue).length);
  md.push(
    "### 거름망 변화",
    "",
    `- 새 거름망에만 걸린 고유 대사 ${newlyTriggered.length}개 (새로 판정 호출을 부르는 대사): ${newlyTriggered.map((j) => `"${j.item.dialogue.slice(0, 40)}" [${j.newTriggers.join(",")}]`).join(" · ") || "없음"}`,
    `- 고유 대사 중 거름망에 걸린 비율: 이전 ${pct([...jobs.values()].filter((j) => RJ.oldTriggers(j.item.dialogue).length).length, jobs.size)} → 새 ${pct([...jobs.values()].filter((j) => j.newTriggers.length).length, jobs.size)} (판정 호출이 그만큼 늘어난다)`,
    "",
  );
  json.rejudge = { dirs, runs, items, judged: toJudge.map((j) => ({ ...j, verdicts: verdicts.get(j.item.key) ?? [] })) };
}

// ------------------------------------------------------------------ 실행

const started = Date.now();
md.push(`# 평가 결과 ${stamp}`, "", `- 모드: ${mode} · 프롬프트 ${NPC_PROMPT_VERSION} · 커밋 ${(json.meta as { commit: string; dirty: boolean }).commit}${(json.meta as { dirty: boolean }).dirty ? " (+작업 중 변경)" : ""}`, `- 모델: 분석 ${MODELS.turn_frame} · 대사 ${MODELS.npc_turn} · 장면 판정 ${MODELS.scene_check}`, "- 생성 로직은 바꾸지 않았다. DB에 저장하지 않았다. 대사 품질은 transcripts/를 사람이 읽고 판단한다.", "");

const both = (mind: keyof typeof C.MIND_VARIANTS = "default", swap = false) =>
  C.PLAYS.map((p) => {
    const partner = swap ? (p.partner === "m" ? "f" : "m") : p.partner;
    return { config: `${p.key}${swap ? `→${partner}` : ""}${mind !== "default" ? `·${mind}` : ""}`, play: p, partner: partner as "m" | "f", mind };
  });
type ReplayConfig = ReturnType<typeof both>[number];

// --- 실행할 것과 계획 (호출 수·비용)
const R = {
  replay: [] as ReplayConfig[],
  replayRuns: runsOpt ?? 3,
  cross: [] as ReplayConfig[],
  crossRuns: runsOpt ?? 2,
  mind: [] as ReplayConfig[],
  mindRuns: runsOpt ?? 2,
  ledgerRuns: mode === "all" ? (runsOpt ?? 5) : (runsOpt ?? 5),
  sceneRuns: mode === "all" ? 3 : (runsOpt ?? 5),
  rejudgeRuns: runsOpt ?? 3,
  appraisalRuns: runsOpt ?? 3,
};
if (mode === "replay") {
  const play = opt("play");
  const partner = opt("partner") as "m" | "f" | undefined;
  const mind = (opt("mind") ?? "default") as keyof typeof C.MIND_VARIANTS;
  R.replay = C.PLAYS.filter((p) => !play || p.key === play).map((p) => ({ config: `${p.key}${partner && partner !== p.partner ? `→${partner}` : ""}${mind !== "default" ? `·${mind}` : ""}`, play: p, partner: partner ?? p.partner, mind }));
}
if (mode === "cross") R.cross = [...both(), ...both("default", true)];
if (mode === "mind") R.mind = [...both(), ...both("soft")];
if (mode === "all") {
  R.replay = both();
  R.replayRuns = 3;
  R.cross = both("default", true);
  R.crossRuns = 2;
  R.mind = both("soft");
  R.mindRuns = 2;
}
const rejudgeDirs = mode === "rejudge" ? argv.slice(1).filter((x, i, a) => !x.startsWith("--") && !(i > 0 && a[i - 1]!.startsWith("--"))) : [];
if (mode === "rejudge" && !rejudgeDirs.length) {
  console.log("사용법: npm run eval -- rejudge <결과폴더...> [--runs 3]");
  process.exit(1);
}
const rejudgeData = mode === "rejudge" ? loadRejudge(rejudgeDirs) : null;

const plan = B.emptyPlan();
const lines = (configs: readonly ReplayConfig[]) => configs.reduce((a, c) => a + c.play.lines.length, 0);
B.addToPlan(plan, "리플레이 마디", lines(R.replay) * R.replayRuns, TURN);
B.addToPlan(plan, "다른 연인 마디", lines(R.cross) * R.crossRuns, TURN);
B.addToPlan(plan, "다른 마음 마디", lines(R.mind) * R.mindRuns, TURN);
const one = (k: CallKind) => ({ expected: EST[k], max: EST[k], expectedCalls: 1, maxCalls: 1 });
if (mode === "ledger" || mode === "all") B.addToPlan(plan, "장부 사례 1차 호출", C.LEDGER_CASES.length * R.ledgerRuns, one("turn_frame"));
if (mode === "scene" || mode === "all") B.addToPlan(plan, "장면 판정", C.SCENE_CASES.length * R.sceneRuns, one("scene_check"));
if (rejudgeData) B.addToPlan(plan, "재판정", rejudgeData.toJudge.length * R.rejudgeRuns, one("scene_check"));
// 실험 1 대사 한 번: 대사 평균 1.15회(최대 2) + 판정 평균 0.45회(최대 2). 1차는 발화·연인마다 한 번
const APPRAISAL_GEN = { expected: 1.15 * EST.npc_turn + 0.45 * EST.scene_check, max: 2 * EST.npc_turn + 2 * EST.scene_check, expectedCalls: 1.6, maxCalls: 4 };
if (mode === "appraisal") {
  B.addToPlan(plan, "실험 1 1차 (A·B 공통)", C.APPRAISAL_LINES.length * 2, one("turn_frame"));
  B.addToPlan(plan, "실험 1 대사 (A·B × 윤재·서아)", C.APPRAISAL_LINES.length * 2 * 2 * R.appraisalRuns, APPRAISAL_GEN);
}

const maxUsd = opt("max-usd") ? Number(opt("max-usd")) : B.defaultMaxUsd(plan);
const planText = [
  `예정: 호출 약 ${Math.round(plan.expectedCalls)}회 (최대 ${plan.maxCalls}회) · 예상 $${plan.expectedUsd.toFixed(4)} (최대 $${plan.maxUsd.toFixed(4)}) · 상한 $${maxUsd.toFixed(4)}${opt("max-usd") ? "" : " (예상의 1.5배, --max-usd로 바꿈)"}`,
  ...plan.lines.map((l) => `  - ${l}`),
  "  - 예상은 2026-11-22 기준선의 호출당 평균 비용으로 계산했다. 상한은 호출 전 예상으로 확인하고 호출 후 실제 비용을 누적한다. 진행 중이던 요청 때문에 실제 비용이 상한을 약간 넘을 수 있다.",
];
console.log(planText.join("\n"));
if (argv.includes("--plan")) process.exit(0);
if (usesLlm) {
  const g = B.gate(plan, { yes: argv.includes("--yes") });
  if (!g.ok) {
    console.log(`\n${g.reason}`);
    process.exit(2);
  }
}
budget = new B.Budget(maxUsd, EST);
md.push("## 계획", "", ...planText.map((l) => (l.startsWith("  - ") ? l.slice(2) : `- ${l}`)), "");
json.plan = { ...plan, maxUsd };

try {
  if (mode === "offline" || mode === "all") runOffline();
  if (mode === "scene" || mode === "all") await runScene(R.sceneRuns);
  if (mode === "ledger" || mode === "all") await runLedger(R.ledgerRuns);
  if (R.replay.length) json.replay = await runReplay(R.replay, R.replayRuns, mode === "all" ? "리플레이 (기록된 판, 원래 연인)" : "리플레이");
  if (R.cross.length) json.cross = await runReplay(R.cross, R.crossRuns, mode === "all" ? "같은 플레이어 말, 다른 연인 (H4 기준선) — 원래 연인 결과는 위 리플레이와 비교" : "같은 플레이어 말, 다른 연인 (H4 기준선)");
  if (R.mind.length) json.mind = await runReplay(R.mind, R.mindRuns, mode === "all" ? "같은 대화, 다른 시작 마음 soft (H5 기준선) — default는 위 리플레이와 비교" : "같은 대화, 다른 시작 마음 (H5 기준선)");
  if (rejudgeData) await runRejudge(rejudgeDirs, R.rejudgeRuns, rejudgeData);
  if (mode === "appraisal") await runAppraisal(R.appraisalRuns);
  if (mode === "v3compare") {
    const [a, b] = argv.slice(1, 3);
    if (!a || !b) throw new Error("사용법: npm run eval -- v3compare <결과폴더A> <결과폴더B>");
    type Saved = { replay?: RunResult[]; cross?: RunResult[]; mind?: RunResult[]; scene?: { expect: string; service: string; source?: string }[]; cost?: { byType: Record<string, { calls: number; usd: number }> } };
    for (const [name, d] of [["A", a], ["B", b]] as const) {
      const j = JSON.parse(readFileSync(`${d}/results.json`, "utf8")) as Saved;
      const runs = [...(j.replay ?? []), ...(j.cross ?? []), ...(j.mind ?? [])];
      md.push(`## ${name}: ${d}`, "");
      if (runs.length) md.push(...v3Table(runs), "");
      if (j.scene) {
        const fp = j.scene.filter((r) => r.expect === "ok" && r.service === "막음").length;
        const fn = j.scene.filter((r) => r.expect === "contradiction" && r.service !== "막음").length;
        md.push(`- 판정 사례: 오탐 ${fp}/${j.scene.filter((r) => r.expect === "ok").length} · 미탐 ${fn}/${j.scene.filter((r) => r.expect === "contradiction").length}`);
      }
      const sc = j.cost?.byType?.scene_check;
      if (sc) md.push(`- scene_check 호출 ${sc.calls}회 · $${sc.usd.toFixed(4)}`);
      md.push("");
    }
  }
} catch (e) {
  // 예상하지 못한 오류여도 그때까지 모은 결과는 저장한다
  md.push(`> ❌ 실행 중 오류: ${e instanceof Error ? e.message : String(e)}`, "");
  json.error = e instanceof Error ? e.message : String(e);
} finally {
  if (budget.stopped) {
    md.splice(5, 0, `> ⚠️ **중간에 멈춤:** ${budget.stopped}. 아래는 멈추기 전까지 모은 결과다.`, "");
    json.stopped = budget.stopped;
  }
  md.push(
    "## 비용",
    "",
    `- 호출 ${cost.calls}회 · 입력 ${cost.input} (캐시 ${cost.cached}, ${pct(cost.cached, cost.input)}) · 출력 ${cost.output} · **$${cost.usd.toFixed(4)}** (예상 $${plan.expectedUsd.toFixed(4)}, 상한 $${maxUsd.toFixed(4)}) · ${((Date.now() - started) / 1000).toFixed(0)}초`,
    ...(budget.missingCost ? [`- 비용 정보 없이 끝난 호출 ${budget.missingCost}회는 예상 비용으로 셌다`] : []),
  );
  for (const [k, v] of Object.entries(cost.byType)) {
    const configured = MODELS[k as keyof typeof MODELS];
    const responded = Object.entries(v.responded).map(([m, n]) => `${m}×${n}`).join(", ");
    // 공급자는 날짜가 붙은 이름으로 답할 수 있어 앞부분만 비교한다
    const mismatch = Object.keys(v.responded).some((m) => m !== "(응답 없음)" && !m.startsWith(configured));
    md.push(`- ${k}: ${v.calls}회 · $${v.usd.toFixed(4)} · 입력 ${v.input} (캐시 ${pct(v.cached, v.input)}) · 설정 ${configured} · 실제 응답 ${responded}${mismatch ? " ⚠️ 설정과 다름" : ""}`);
  }
  md.push("");
  json.cost = { ...cost, budgetSpent: budget.spent };
  writeFileSync(`${outDir}/summary.md`, md.join("\n"));
  writeFileSync(`${outDir}/results.json`, JSON.stringify(json, null, 2));
  console.log(`\n${budget.stopped ? `멈춤 (${budget.stopped}) — ` : ""}완료: ${outDir}/summary.md · $${cost.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}초`);
}
