// 터미널에서 연인과 직접 대화하며 말투를 본다. 웹과 같은 서버 코드(프롬프트, 점수 규칙, 끝맺음)를 쓴다.
// 저장소(Supabase)에는 기록하지 않는다. OpenRouter 키가 필요하다 (.env 또는 .env.local).
//
//   npm run play            # 윤재
//   npm run play -- f       # 서아
//
// 대화 중 명령:
//   /again   방금 대답을 같은 말로 다시 생성 (말투 비교용, 점수는 첫 대답 기준)
//   /prompt  이번 차례에 모델에 들어간 프롬프트 보기
//   /state   이번 판에서만 유지되는 현재 마음·관계 상태 보기
//   /quit    끝내기
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadEnv } from "./env.js";
loadEnv();

const { scenarioFor, PARTNERS } = await import("../server/content.js");
const { npcReply, buildNpcPrompt, NPC_PROMPT_VERSION } = await import("../server/npc.js");
const { modelConfig } = await import("../server/model-config.js");
const { checkMessage, chooseMove, newGame, recordTurn, finish, RULES, shakePercent } = await import("../server/rules.js");
const { buildReport } = await import("../server/report.js");
const { writeBelief } = await import("../server/belief.js");
const { writeHeadline } = await import("../server/headline.js");
const { isScripted } = await import("../server/llm.js");

const c = { dim: (s: string) => `\x1b[2m${s}\x1b[0m`, b: (s: string) => `\x1b[1m${s}\x1b[0m`, blue: (s: string) => `\x1b[34m${s}\x1b[0m`, yellow: (s: string) => `\x1b[33m${s}\x1b[0m` };
type Beat = { type: "narration" | "dialogue"; content: string };
const show = (beats: Beat[], name: string) => {
  for (const b of beats) console.log(b.type === "narration" ? c.dim(`  *${b.content}*`) : `  ${c.b(name)}  ${b.content}`);
};
const showState = (s: typeof state) => {
  const m = s.currentMind;
  const live = (xs: { text: string; status: string }[]) => xs.filter((x) => x.status === "held").map((x) => x.text).join(" / ") || "없음";
  console.log(c.dim(`  마음  피곤 ${m.fatigue} · 미안함 ${m.guilt} · 방어심 ${m.defensiveness} · 챙김 ${m.care} · 열림 ${m.openness}`));
  console.log(c.dim(`  초점  ${m.focus} / 바람  ${m.want}`));
  console.log(c.dim(`  관계  인정: ${live(s.relationship.acknowledged)} | 유지: ${live(s.relationship.retained)}`));
  console.log(c.dim(`        미해결: ${live(s.relationship.unresolved)} | 제안: ${live(s.relationship.proposals)} | 합의: ${s.relationship.agreement}`));
  console.log(c.dim(`        플레이어 태도: ${live(s.relationship.playerStances)} | 점수 이벤트: ${s.relationship.progress.map((x) => x.type === "mutual_agreement" ? x.type : `${x.type}:${x.issue}`).join(", ") || "없음"}`));
};

const partner = process.argv[2] === "f" ? "f" : "m";
const name = PARTNERS[partner].name;
const sc = scenarioFor(partner);
console.log(c.dim(`프롬프트 ${NPC_PROMPT_VERSION} · 대사 ${isScripted() ? "대본 모드 (키 없음)" : modelConfig("npc_turn").model} · 상태 ${modelConfig("turn_frame").model}`));
console.log(c.dim(`${sc.place} · ${name} · ${RULES.maxTurns}마디, ${RULES.charBudget}자\n`));
show(sc.opening, name);

let state = newGame(`cli-${Date.now()}`, Date.now(), false, partner);
let lastPrompt = "";
const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false });
const lines = rl[Symbol.asyncIterator]();
const ask = async (prompt: string): Promise<string | null> => {
  stdout.write(prompt);
  const r = await lines.next();
  if (r.done) return null;
  if (!stdin.isTTY) stdout.write(`${r.value}\n`);
  return r.value;
};

while (!state.finished) {
  const raw = await ask(`\n${c.blue(`나 (${state.turns.length + 1}/${RULES.maxTurns}, ${RULES.charBudget - state.charsUsed}자 남음)`)} > `);
  const input = (raw ?? "/quit").trim();
  if (input === "/quit") {
    state = finish(state, "giveup");
    break;
  }
  if (input === "/prompt") {
    console.log(c.dim(lastPrompt || "아직 없어요."));
    continue;
  }
  if (input === "/state") {
    showState(state);
    continue;
  }
  if (input === "/again") {
    const prev = state.turns.at(-1);
    if (!prev) {
      console.log(c.dim("다시 생성할 대답이 없어요."));
      continue;
    }
    const before = { ...state, turns: state.turns.slice(0, -1), score: state.score + prev.applied, charsUsed: state.charsUsed - Array.from(prev.player).length };
    const r = await npcReply(before, prev.player);
    if (!r.ok) console.log(c.dim(`(실패: ${r.failure.message})`));
    else {
      console.log(c.dim("  ── 같은 말, 다른 대답 (점수는 바뀌지 않아요) ──"));
      show(r.reply.beats, name);
      console.log(c.dim(`  [${r.reply.move}] +${r.reply.suggested}% 제안 · 속마음: ${r.reply.reason} · 알게 된 것: ${r.reply.noticed}`));
    }
    continue;
  }
  const check = checkMessage(state, input);
  if (!check.ok) {
    console.log(c.dim(check.reason));
    continue;
  }
  const before = state;
  const move = chooseMove(before);
  const r = await npcReply(state, check.text);
  if (!r.ok) {
    console.log(c.dim(`(생성 실패: ${r.failure.message} — 같은 말을 다시 보내 보세요)`));
    continue;
  }
  const p = buildNpcPrompt(before, check.text, r.reply.move, r.reply.frame);
  lastPrompt = `${p.system}\n\n----- user -----\n${p.user}`;
  state = recordTurn(state, { player: check.text, npc: r.reply.beats, move: r.reply.move, frame: r.reply.frame, thought: r.reply.reason, noticed: r.reply.noticed, suggested: r.reply.suggested, labels: r.reply.labels });
  const t = state.turns.at(-1)!;
  show(r.reply.beats, name);
  console.log(
    c.dim(`  [${t.move}] +${t.applied}%${t.applied !== t.suggested ? ` (제안 ${t.suggested})` : ""} → 누적 ${shakePercent(state.score)}% · ${t.labels.join(", ") || "라벨 없음"}`),
  );
  if (t.scoreBreakdown) {
    const b = t.scoreBreakdown;
    console.log(c.dim(`  점수 산식  AI ${b.base}${b.eventBonus ? ` + 이벤트 ${b.eventBonus}` : ""}${b.mindBonus ? ` + 마음 ${b.mindBonus}` : ""} = ${b.applied}`));
  }
  const evaluation = t.frame?.evaluation;
  if (evaluation) {
    console.log(c.dim(`  AI 평가  ${evaluation.reason}`));
    if (evaluation.evidence.length) console.log(c.dim(`  평가 근거  ${evaluation.evidence.map((x) => `“${x}”`).join(" · ")}`));
  }
  console.log(c.yellow(`  속마음: ${t.thought ?? ""}`) + c.dim(`  · 알게 된 것: ${t.noticed ?? ""}`));
  console.log(c.dim("  ── 세션 상태 (이번 턴 후) ──"));
  showState(state);
}
rl.close();

const report = buildReport(state);
console.log(`\n${c.b(`결과: ${report.outcome} · ${name}의 마음을 ${report.shake}% 움직였어요`)} ${c.dim(`(성공 기준 ${report.successShake}%)`)}`);
if (state.turns.length > 0) {
  console.log(c.dim("\n대화 피드백을 정리하는 중…"));
  const b = await writeBelief(state);
  if (!b.ok) console.log(c.dim(`(실패: ${b.failure?.message ?? "대화 없음"})`));
  else {
    console.log(`\n${c.b("대화 피드백")}`);
    console.log(`  ${b.belief.summary}`);
    for (const pt of b.belief.points) console.log(`  - ${c.b(`좋았던 점 · ${pt.strength}`)}  ${c.dim(`근거 ${pt.turn}번째 말 "${pt.quote}"`)}\n    보완할 점 · ${pt.improve}\n    다음에는 · ${pt.suggestion}`);
    console.log(`  ${b.belief.closing}`);
  }

  console.log(c.dim(`\n● LIVE  사실 이 대화는 은하연애위원회에 생중계되고 있었습니다. 1,000년 뒤 신문을 인쇄하는 중…`));
  const h = await writeHeadline(state);
  if (!h.ok) console.log(c.dim(`(실패: ${h.failure?.message ?? "대화 없음"})`));
  else {
    console.log(`\n${c.dim("은하 연합 타임스 · 3026년 특별판")}`);
    console.log(`  ${c.b(h.headline.title)}`);
    console.log(`  ${h.headline.subtitle}`);
    console.log(c.dim(`  “${h.headline.quote}” — ${h.headline.quoteTurn}번째 말`));
    console.log(`  ${h.headline.textbook}`);
    for (const a of h.headline.sideArticles) console.log(c.dim(`  · ${a}`));
  }
}
