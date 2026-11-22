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
//   --label 이름                          # 결과 폴더 이름에 붙임
//
// 결과: eval-results/<시각>-<label>/ (gitignore)
//   summary.md          사람용 요약 (지표 표)
//   results.json        원자료 전체
//   transcripts/*.md    리플레이 전사본 (대사 품질은 사람이 이걸 보고 판단한다)
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env.js";
loadEnv();

const { npcReply, buildFactsPrompt, parseFacts, FACTS_JSON_SCHEMA, replyRepetitionViolation, NPC_PROMPT_VERSION } = await import("../server/npc.js");
const { newGame, recordTurn, shakePercent } = await import("../server/rules.js");
const { callWithRetry, isScripted } = await import("../server/llm.js");
const { modelConfig } = await import("../server/model-config.js");
const { buildSceneCheckPrompt, parseSceneVerdict, SCENE_JSON_SCHEMA, sceneTriggers } = await import("../server/checks.js");
const { sceneFactsFor, PARTNERS } = await import("../server/content.js");
const { ledgerLines } = await import("../server/ledger.js");
const C = await import("./eval/cases.js");
const M = await import("./eval/metrics.js");

type GameState = ReturnType<typeof newGame>;
type Attempt = { usage: { promptTokens: number | null; completionTokens: number | null; cachedTokens?: number | null; cost: number | null } | null; latencyMs: number; result: string; responseText: string | null };

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

if (isScripted() && mode !== "offline") {
  console.log("OPENROUTER_API_KEY가 없거나 SCRIPTED=1이라 실제 모델을 부르지 않아요. 기준선은 실제 모델로 만들어야 해요 (offline만 가능).");
  process.exit(1);
}

// ------------------------------------------------------------------ 공통

const cost = { calls: 0, input: 0, cached: 0, output: 0, usd: 0, byType: {} as Record<string, { calls: number; usd: number; input: number; cached: number }> };
function account(type: string, attempts: readonly Attempt[]) {
  for (const a of attempts) {
    const u = a.usage;
    cost.calls++;
    cost.input += u?.promptTokens ?? 0;
    cost.cached += u?.cachedTokens ?? 0;
    cost.output += u?.completionTokens ?? 0;
    cost.usd += u?.cost ?? 0;
    const t = (cost.byType[type] ??= { calls: 0, usd: 0, input: 0, cached: 0 });
    t.calls++;
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
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!, i);
      }
    }),
  );
  return out;
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "-");
const md: string[] = [];
const json: Record<string, unknown> = { mode, stamp, promptVersion: NPC_PROMPT_VERSION, models: { turn_frame: modelConfig("turn_frame").model, npc_turn: modelConfig("npc_turn").model, scene_check: modelConfig("scene_check").model } };
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
  md.push("| 사례 | 확인하는 것 | 기대 일치 | 기록 일치율 | 버려진 항목 | 가장 흔한 기록 |", "| --- | --- | --- | --- | --- | --- |");
  const out: unknown[] = [];
  for (const cs of C.LEDGER_CASES) {
    let s: GameState = newGame(`eval-ledger-${cs.key}`, Date.now(), false, cs.partner);
    for (const p of cs.prefix) s = recordTurn(s, { player: p.player, npc: p.npc, move: "counter", ...(p.facts ? { facts: p.facts } : {}), suggested: 0, labels: [] });
    const known = new Set(s.ledger.map((x) => x.id));
    const one = async () => {
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
      for (const k of cs.expect.playerNewKindsInclude ?? []) if (!f.added.some((x) => x.by === "player" && x.kind === k)) misses.push(`플레이어 ${k} 없음`);
      for (const k of cs.expect.npcLastKindsExclude ?? []) if (f.added.some((x) => x.by === "npc" && x.kind === k)) misses.push(`연인 ${k} 있음`);
      const raw = M.rawFactsCounts(res.attempts.at(-1)?.responseText ?? null);
      const acc = M.acceptedFactsCounts(f);
      return {
        ok: true as const,
        signature: M.factsSignature(f, known),
        misses,
        dropped: raw ? Math.max(0, raw.items - acc.items) + Math.max(0, raw.resolves - acc.resolves) : null,
        facts: f,
      };
    };
    const rs = await pool(Array.from({ length: runs }), 3, one);
    const oks = rs.filter((r) => r.ok) as Extract<(typeof rs)[number], { ok: true }>[];
    const a = M.agreement(oks.map((r) => r.signature));
    const pass = oks.filter((r) => r.misses.length === 0).length;
    const missTally = Object.entries(oks.flatMap((r) => r.misses).reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k}×${v}`).join(", ");
    md.push(`| ${cs.key} | ${cs.about} | ${pass}/${oks.length}${missTally ? ` (${missTally})` : ""} | ${pct(a.rate * oks.length, oks.length)} | ${oks.reduce((x, r) => x + (r.dropped ?? 0), 0)} | \`${a.modal}\` |`);
    out.push({ case: cs.key, results: rs });
  }
  md.push("");
  json.ledger = out;
}

// ------------------------------------------------------------------ V3 장면 판정

async function runScene() {
  console.log(`· scene: ${C.SCENE_CASES.length}줄`);
  md.push("## V3 장면 판정 기준선", "", "실제 서비스는 거름망에 걸린 대사만 판정한다. 여기서는 판정 자체의 정확도를 따로 보려고 모든 줄을 판정한다.", "");
  md.push("| 기대 | 대사 | 거름망 | 판정 | 실제 서비스 결과 | 메모 |", "| --- | --- | --- | --- | --- | --- |");
  const rows = await pool(C.SCENE_CASES, 4, async (sc) => {
    const triggers = sceneTriggers(sc.line);
    const p = buildSceneCheckPrompt(sceneFactsFor("m"), PARTNERS.m.name, sc.player, sc.line);
    const res = await callWithRetry(modelConfig("scene_check"), { ...p, schemaName: "scene_check", schema: SCENE_JSON_SCHEMA }, (j) => parseSceneVerdict(j));
    account("scene_check", res.attempts);
    const verdict = res.ok ? res.value.verdict : "unclear";
    const service = triggers.length ? (verdict === "contradiction" ? "막음" : "통과") : "통과(거름망 밖)";
    return { ...sc, triggers, verdict, reason: res.ok ? res.value.reason : res.failure.message, service };
  });
  for (const r of rows) md.push(`| ${r.expect} | ${r.line} | ${r.triggers.join(",") || "-"} | ${r.verdict} (${r.reason}) | ${r.service} | ${r.note ?? ""} |`);
  const mustCatch = rows.filter((r) => r.expect === "contradiction");
  const mustPass = rows.filter((r) => r.expect === "ok");
  md.push(
    "",
    `- 막아야 할 것 중 실제로 막음: ${mustCatch.filter((r) => r.service === "막음").length}/${mustCatch.length} (거름망 밖이라 놓침 ${mustCatch.filter((r) => !r.triggers.length).length}, 판정이 놓침 ${mustCatch.filter((r) => r.triggers.length && r.verdict !== "contradiction").length})`,
    `- 통과시켜야 할 것 중 잘못 막음(오탐): ${mustPass.filter((r) => r.service === "막음").length}/${mustPass.length}`,
    `- 판정만 보면 정확: ${rows.filter((r) => (r.expect === "contradiction") === (r.verdict === "contradiction")).length}/${rows.length}`,
    "",
  );
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

// ------------------------------------------------------------------ 실행

const started = Date.now();
md.push(`# 평가 결과 ${stamp}`, "", `- 모드: ${mode} · 프롬프트 ${NPC_PROMPT_VERSION}`, `- 모델: 분석 ${modelConfig("turn_frame").model} · 대사 ${modelConfig("npc_turn").model} · 장면 판정 ${modelConfig("scene_check").model}`, "- 생성 로직은 바꾸지 않았다. DB에 저장하지 않았다. 대사 품질은 transcripts/를 사람이 읽고 판단한다.", "");

const both = (mind: keyof typeof C.MIND_VARIANTS = "default", swap = false) =>
  C.PLAYS.map((p) => {
    const partner = swap ? (p.partner === "m" ? "f" : "m") : p.partner;
    return { config: `${p.key}${swap ? `→${partner}` : ""}${mind !== "default" ? `·${mind}` : ""}`, play: p, partner: partner as "m" | "f", mind };
  });

if (mode === "replay") {
  const play = opt("play");
  const partner = opt("partner") as "m" | "f" | undefined;
  const mind = (opt("mind") ?? "default") as keyof typeof C.MIND_VARIANTS;
  const sel = C.PLAYS.filter((p) => !play || p.key === play).map((p) => ({ config: `${p.key}${partner && partner !== p.partner ? `→${partner}` : ""}${mind !== "default" ? `·${mind}` : ""}`, play: p, partner: partner ?? p.partner, mind }));
  json.replay = await runReplay(sel, runsOpt ?? 3, "리플레이");
}
if (mode === "cross") json.cross = await runReplay([...both(), ...both("default", true)], runsOpt ?? 2, "같은 플레이어 말, 다른 연인 (H4 기준선)");
if (mode === "mind") json.mind = await runReplay([...both(), ...both("soft")], runsOpt ?? 2, "같은 대화, 다른 시작 마음 (H5 기준선)");
if (mode === "ledger") await runLedger(runsOpt ?? 5);
if (mode === "scene") await runScene();
if (mode === "offline") runOffline();
if (mode === "all") {
  runOffline();
  await runScene();
  await runLedger(runsOpt ?? 5);
  json.replay = await runReplay(both(), 3, "리플레이 (기록된 판, 원래 연인)");
  json.cross = await runReplay(both("default", true), 2, "같은 플레이어 말, 다른 연인 (H4 기준선) — 원래 연인 결과는 위 리플레이와 비교");
  json.mind = await runReplay(both("soft"), 2, "같은 대화, 다른 시작 마음 soft (H5 기준선) — default는 위 리플레이와 비교");
}

md.push("## 비용", "", `- 호출 ${cost.calls}회 · 입력 ${cost.input} (캐시 ${cost.cached}, ${pct(cost.cached, cost.input)}) · 출력 ${cost.output} · **$${cost.usd.toFixed(4)}** · ${((Date.now() - started) / 1000).toFixed(0)}초`);
for (const [k, v] of Object.entries(cost.byType)) md.push(`- ${k}: ${v.calls}회 · $${v.usd.toFixed(4)} · 입력 ${v.input} (캐시 ${pct(v.cached, v.input)})`);
md.push("");
json.cost = cost;
writeFileSync(`${outDir}/summary.md`, md.join("\n"));
writeFileSync(`${outDir}/results.json`, JSON.stringify(json, null, 2));
console.log(`\n완료: ${outDir}/summary.md · $${cost.usd.toFixed(4)} · ${((Date.now() - started) / 1000).toFixed(0)}초`);
