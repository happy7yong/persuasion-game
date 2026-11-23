// 대화 장부: 이 판에서 실제로 말해진 약속·제안·걱정·요청·한계를 "누가, 몇 번째 마디에서, 원문 인용과 함께" 쌓는다.
// docs/dialogue-architecture.md §6. 원칙:
// - 장부는 사실만 담는다. 무엇을 말하라는 지시(focus·retain·mustAddress 같은)는 없다.
// - LLM(1차 발화 분석)은 장부 변경을 "제안"하고, 여기서 인용·id·상태를 검증해 확정한다.
// - 감정 단계와 점수 이벤트는 확정된 장부 변경에서 코드 규칙으로 계산한다 (§11 D2).
import { z } from "zod";

export const ISSUE_IDS = ["read-gap", "intent-trust", "availability", "repair-method"] as const;
export type IssueId = (typeof ISSUE_IDS)[number];

export type Speaker = "npc" | "player";
export const LEDGER_KINDS = ["commitment", "proposal", "concern", "request", "limit"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export type LedgerStatus = "open" | "accepted" | "rejected" | "closed";

export interface LedgerItem {
  id: string;
  /** 누가 말했나. 역할이 뒤바뀌지 않게 하는 핵심 */
  by: Speaker;
  kind: LedgerKind;
  issue: IssueId;
  /** 한 줄 요약 */
  text: string;
  /** 원문 인용 (장면 시작 항목은 장면 원문) */
  quote: string;
  /** 생긴 마디 (0 = 장면 시작) */
  turn: number;
  status: LedgerStatus;
  resolvedBy?: { turn: number; by: Speaker; quote: string };
}

export const PLAYER_ACTS = ["apology", "request", "accept", "reject", "question", "accuse", "explain", "feeling", "propose", "promise", "other"] as const;
export type PlayerAct = (typeof PLAYER_ACTS)[number];

export interface Resolution {
  id: string;
  by: Speaker;
  status: "accepted" | "rejected" | "closed";
  quote: string;
}

/** 1차 발화 분석을 검증해 확정한 이번 마디의 사실. 그대로 저장되고, 다시 적용하면 같은 장부가 나온다. */
export interface TurnFacts {
  v: 2;
  /** 새 장부 항목 (직전 NPC 말 + 이번 플레이어 말). id·상태가 확정돼 있다 */
  added: LedgerItem[];
  /** 이번에 상태가 바뀐 항목 */
  resolved: Resolution[];
  /** 이번 플레이어 말이 하는 일 */
  acts: { act: PlayerAct; quote: string; refersTo: string }[];
  evaluation: { suggested_drop: number; labels: string[]; reason: string; noticed: string; evidence: string[] };
  /**
   * 1차 출력 중 검증에서 버린 것과 이유 (인용이 원문에 없음, 없는 id, 권한 위반 등).
   * **진단 정보일 뿐이다.** 장부·감정·점수 계산과 대사 프롬프트에 쓰지 않는다. 없으면 버린 게 없다 (예전 기록도 없음).
   */
  dropped?: string[];
}

export const isTurnFacts = (x: unknown): x is TurnFacts => typeof x === "object" && x !== null && (x as { v?: unknown }).v === 2 && Array.isArray((x as { acts?: unknown }).acts);

/** 장면 시작 때 이미 말해진 것 (오프닝 대사와 카톡). */
export function initialLedger(): LedgerItem[] {
  return [
    { id: "L1", by: "npc", kind: "limit", issue: "availability", text: "일할 때는 연락에 바로 답하기 어렵다", quote: "일할 땐 오늘처럼 답 늦을 때도 있어", turn: 0, status: "open" },
    { id: "L2", by: "npc", kind: "concern", issue: "intent-trust", text: "'나 무시해?'라는 말이 서운하다. 일부러 피한 게 아니다", quote: "'나 무시해?'는 좀…", turn: 0, status: "open" },
    { id: "L3", by: "player", kind: "concern", issue: "read-gap", text: "읽고도 몇 시간 답이 없어 불안하고 서운했다", quote: "나 무시해?", turn: 0, status: "open" },
  ];
}

// ------------------------------------------------------------------ 1차 출력 검증

const RawItem = z.object({ kind: z.enum(LEDGER_KINDS), issue: z.enum(ISSUE_IDS), text: z.string().trim().min(1).max(120), quote: z.string().trim().min(1).max(60) });
const RawResolve = z.object({ id: z.string().trim().min(1).max(8), status: z.enum(["accepted", "rejected", "closed"]), quote: z.string().trim().min(1).max(60) });
export const RawFactsSchema = z.object({
  npcLast: z.array(RawItem).max(3),
  npcResolved: z.array(RawResolve).max(3),
  acts: z.array(z.object({ act: z.enum(PLAYER_ACTS), quote: z.string().trim().min(1).max(60), refersTo: z.string().trim().max(8) })).min(1).max(3),
  playerNew: z.array(RawItem).max(3),
  playerResolved: z.array(RawResolve).max(3),
  evaluation: z.object({
    suggested_drop: z.number().int().min(0).max(14),
    labels: z.array(z.string()).max(2),
    reason: z.string().trim().min(1).max(180),
    noticed: z.string().trim().min(1).max(80),
    evidence: z.array(z.string().trim().min(1).max(180)).max(2),
  }),
});

const squash = (t: string) => t.replace(/[\s"'“”‘’.,!?~…·]/g, "");
/** 인용이 원문에 있는지 (공백·문장부호 차이는 무시). */
export const quoted = (source: string, quote: string): boolean => {
  const q = squash(quote);
  return q.length >= 2 && squash(source).includes(q);
};

/**
 * 1차 출력을 검증해 TurnFacts로 확정한다.
 * strict(첫 시도): 인용·id가 하나라도 틀리면 거부해 다시 생성한다. 아니면(마지막 시도) 틀린 것만 버린다.
 * @param prevNpc 직전 NPC 말 원문 (첫 마디는 오프닝)
 * @param turn 이번 마디 번호 (1부터)
 */
export function resolveFacts(ledger: readonly LedgerItem[], raw: unknown, ctx: { playerText: string; prevNpc: string; turn: number }, strict: boolean): TurnFacts {
  const r = RawFactsSchema.parse(raw);
  // problems: 출력이 틀린 것 (strict면 거부) · skipped: 틀리진 않았지만 반영하지 않은 것 (중복·첫 마디의 npcLast·없는 연결)
  // 둘 다 dropped로 남긴다. 진단용이며 확정 장부에는 들어가지 않는다.
  const problems: string[] = [];
  const skipped: string[] = [];
  const keep = <T>(ok: boolean, why: string, x: T): T | null => {
    if (ok) return x;
    problems.push(why);
    return null;
  };
  const item = (it: { kind: string; text: string; quote: string }) => `${it.kind} "${it.text}" / 인용 "${it.quote}"`;

  let next = ledger.length + 1;
  const added: LedgerItem[] = [];
  const nIds = new Map<string, string>();
  // 직전 NPC 말에서 생긴 항목. 첫 마디는 오프닝이 이미 장면 시작 항목에 들어 있다.
  if (ctx.turn <= 1) for (const it of r.npcLast) skipped.push(`npc_first_turn: ${item(it)}`);
  if (ctx.turn > 1) {
    r.npcLast.forEach((it, i) => {
      const ok = keep(quoted(ctx.prevNpc, it.quote), `npc_quote: ${item(it)}`, it);
      if (!ok) return;
      if ([...ledger, ...added].some((x) => x.by === "npc" && x.text === it.text)) return void skipped.push(`duplicate: ${item(it)}`);
      const id = `L${next++}`;
      nIds.set(`N${i + 1}`, id);
      added.push({ id, by: "npc", kind: it.kind, issue: it.issue, text: it.text, quote: it.quote, turn: ctx.turn - 1, status: "open" });
    });
  }
  for (const it of r.playerNew) {
    if (!keep(quoted(ctx.playerText, it.quote), `player_quote: ${item(it)}`, it)) continue;
    if ([...ledger, ...added].some((x) => x.by === "player" && x.text === it.text)) {
      skipped.push(`duplicate: ${item(it)}`);
      continue;
    }
    added.push({ id: `L${next++}`, by: "player", kind: it.kind, issue: it.issue, text: it.text, quote: it.quote, turn: ctx.turn, status: "open" });
  }

  const all = [...ledger, ...added];
  const idOf = (id: string) => nIds.get(id) ?? id;
  const resolved: Resolution[] = [];
  const resolve = (x: z.infer<typeof RawResolve>, by: Speaker, source: string) => {
    const id = idOf(x.id);
    const found = all.find((i) => i.id === id);
    const target = found?.status === "open" ? found : undefined;
    const why = found ? `not_open: ${by} ${x.id} ${x.status} (이미 ${found.status}) / 인용 "${x.quote}"` : `bad_id: ${by} ${x.id} ${x.status} / 인용 "${x.quote}"`;
    if (!keep(Boolean(target), why, true) || !target) return;
    // 상대 항목은 받아들이거나 거절하고, 자기 항목은 거둬들인다
    const allowed = target.by === by ? x.status === "closed" : x.status !== "closed";
    if (!keep(allowed, `bad_status: ${by} ${x.id} ${x.status} (${target.by === by ? "자기" : "상대"} 항목) / 인용 "${x.quote}"`, true)) return;
    if (!keep(quoted(source, x.quote), `${by}_resolve_quote: ${x.id} ${x.status} / 인용 "${x.quote}"`, true)) return;
    if (resolved.some((y) => y.id === id)) return void skipped.push(`duplicate_resolve: ${by} ${x.id} ${x.status}`);
    resolved.push({ id, by, status: x.status, quote: x.quote });
  };
  if (ctx.turn > 1) for (const x of r.npcResolved) resolve(x, "npc", ctx.prevNpc);
  for (const x of r.playerResolved) resolve(x, "player", ctx.playerText);

  const acts: TurnFacts["acts"] = [];
  for (const a of r.acts) {
    if (!keep(quoted(ctx.playerText, a.quote), `act_quote: ${a.act} / 인용 "${a.quote}"`, a)) continue;
    const ref = a.refersTo ? idOf(a.refersTo) : "";
    const refOk = Boolean(ref) && all.some((i) => i.id === ref);
    if (ref && !refOk) skipped.push(`bad_ref: ${a.act} → ${a.refersTo} (연결만 지움)`);
    acts.push({ act: a.act, quote: a.quote, refersTo: refOk ? ref : "" });
  }
  if (acts.length === 0) problems.push("no_acts");

  if (strict && problems.length) throw new Error(`facts_invalid:${problems.slice(0, 3).join(",")}`);
  const dropped = [...problems, ...skipped];
  return { v: 2, added, resolved, acts: acts.length ? acts : [{ act: "other", quote: "", refersTo: "" }], evaluation: r.evaluation, ...(dropped.length ? { dropped } : {}) };
}

/** 확정된 사실을 장부에 적용한다 (순수 함수, 다시 적용해도 같은 결과). */
export function applyFacts(ledger: readonly LedgerItem[], facts: TurnFacts, turn: number): LedgerItem[] {
  const next = [...ledger.map((x) => ({ ...x })), ...facts.added.filter((a) => !ledger.some((x) => x.id === a.id)).map((x) => ({ ...x }))];
  for (const r of facts.resolved) {
    const item = next.find((x) => x.id === r.id);
    if (item && item.status === "open") {
      item.status = r.status;
      item.resolvedBy = { turn: r.by === "npc" ? turn - 1 : turn, by: r.by, quote: r.quote };
    }
  }
  return next;
}

// ------------------------------------------------------------------ 감정 단계 (코드 규칙, §11 D2)

export type MindLevel = 0 | 1 | 2 | 3;
export interface Mind {
  fatigue: MindLevel;
  guilt: MindLevel;
  defensiveness: MindLevel;
  care: MindLevel;
  openness: MindLevel;
}

const clamp = (v: number): MindLevel => Math.max(0, Math.min(3, v)) as MindLevel;
const sign = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * 플레이어의 이번 말이 연인의 마음을 어떻게 바꾸는지. 축마다 한 턴에 최대 한 단계.
 * - 비난·단정 (평가 라벨 pressure와 함께) → 방어심↑, 열림↓
 * - 상대 생각을 물음 → 방어심↓, 열림↑
 * - 연인의 한계·걱정·약속을 받아들임 → 방어심↓
 * - 자기 서운함·사정을 솔직히 설명 → 미안함↑, 챙김↑
 * - 연인의 항목을 짚은 사과 → 방어심↓ / 아무것도 짚지 않은 사과를 두 번째로 반복 → 방어심↑
 * - 방법 제안·자기 행동 약속 → 열림↑
 * 피곤함은 한 판(다섯 마디) 안에서 바뀌지 않는다.
 */
export function nextMind(mind: Mind, facts: TurnFacts, ledger: readonly LedgerItem[], prevFacts: TurnFacts | null): Mind {
  const acts = facts.acts.map((a) => a.act);
  const npcItem = (id: string) => ledger.find((x) => x.id === id && x.by === "npc");
  const d = { guilt: 0, defensiveness: 0, care: 0, openness: 0 };
  // 비난은 발화 행위와 평가 라벨(pressure)이 둘 다 가리킬 때만 반영한다: 분류 하나가 틀려도 마음이 크게 틀어지지 않게
  if (acts.includes("accuse") && facts.evaluation.labels.includes("pressure")) (d.defensiveness += 1), (d.openness -= 1);
  if (acts.includes("question")) (d.defensiveness -= 1), (d.openness += 1);
  if (facts.resolved.some((r) => r.by === "player" && r.status === "accepted" && npcItem(r.id))) d.defensiveness -= 1;
  if ((acts.includes("feeling") || acts.includes("explain")) && !acts.includes("accuse")) (d.guilt += 1), (d.care += 1);
  const apologies = facts.acts.filter((a) => a.act === "apology");
  if (apologies.some((a) => a.refersTo && npcItem(a.refersTo))) d.defensiveness -= 1;
  else if (apologies.length && prevFacts?.acts.some((a) => a.act === "apology" && !a.refersTo) && ledger.some((x) => x.by === "npc" && x.status === "open" && x.kind === "concern"))
    d.defensiveness += 1;
  if (acts.includes("propose") || acts.includes("promise")) d.openness += 1;
  return {
    fatigue: mind.fatigue,
    guilt: clamp(mind.guilt + sign(d.guilt)),
    defensiveness: clamp(mind.defensiveness + sign(d.defensiveness)),
    care: clamp(mind.care + sign(d.care)),
    openness: clamp(mind.openness + sign(d.openness)),
  };
}

// ------------------------------------------------------------------ 점수 이벤트 (장부 변경에서 도출)

export type ProgressEvent =
  | { type: "acknowledged"; issue: IssueId }
  | { type: "player_accepts_limit"; issue: IssueId }
  | { type: "player_changes_approach"; issue: IssueId }
  | { type: "proposal_created"; issue: IssueId }
  | { type: "issue_resolved"; issue: IssueId }
  | { type: "mutual_agreement"; issue: "none" };

/**
 * - acknowledged: 직전 NPC 말이 플레이어의 걱정·요청을 받아들임 (플레이어의 앞선 말이 만든 변화)
 * - player_accepts_limit: 플레이어가 연인의 한계·걱정·약속을 받아들임
 * - player_changes_approach: 플레이어가 자기 행동을 약속함
 * - proposal_created: 플레이어가 방법을 제안함
 * - issue_resolved / mutual_agreement: 마지막 마디에서만
 */
export function progressEvents(facts: TurnFacts, ledgerAfter: readonly LedgerItem[], finalTurn: boolean): ProgressEvent[] {
  const item = (id: string) => ledgerAfter.find((x) => x.id === id);
  const out: ProgressEvent[] = [];
  for (const r of facts.resolved) {
    const it = item(r.id);
    if (!it || r.status !== "accepted") continue;
    if (r.by === "npc" && it.by === "player") out.push({ type: "acknowledged", issue: it.issue });
    if (r.by === "player" && it.by === "npc") out.push({ type: "player_accepts_limit", issue: it.issue });
  }
  for (const it of facts.added.filter((x) => x.by === "player")) {
    if (it.kind === "commitment") out.push({ type: "player_changes_approach", issue: it.issue });
    if (it.kind === "proposal") out.push({ type: "proposal_created", issue: it.issue });
  }
  if (finalTurn) {
    for (const r of facts.resolved.filter((x) => x.by === "player" && x.status !== "rejected")) {
      const it = item(r.id);
      if (it) out.push({ type: "issue_resolved", issue: it.issue });
    }
    const npcCommitAccepted = facts.resolved.some((r) => r.by === "player" && r.status === "accepted" && ["commitment", "proposal"].includes(item(r.id)?.kind ?? ""));
    const playerCommits = ledgerAfter.some((x) => x.by === "player" && (x.kind === "commitment" || x.kind === "proposal") && x.status !== "rejected");
    if (npcCommitAccepted && playerCommits) out.push({ type: "mutual_agreement", issue: "none" });
  }
  return out;
}

// ------------------------------------------------------------------ 프롬프트용 표현 (사실만)

const KIND_KO: Record<LedgerKind, string> = { commitment: "약속", proposal: "제안", concern: "걱정·서운함", request: "요청", limit: "한계" };
const STATUS_KO: Record<LedgerStatus, string> = { open: "열림", accepted: "받아들여짐", rejected: "거절됨", closed: "거둬들임" };

/**
 * 장부를 한 줄씩. perspective "npc"면 NPC를 "너"로 부른다 (대사 모델용), "neutral"이면 "NPC"로 (발화 분석용).
 */
export function ledgerLines(ledger: readonly LedgerItem[], perspective: "npc" | "neutral"): string {
  if (ledger.length === 0) return "- (비어 있음)";
  const who = (s: Speaker) => (s === "player" ? "플레이어" : perspective === "npc" ? "너" : "NPC");
  return ledger
    .map((x) => {
      const when = x.turn === 0 ? "장면 시작" : `${x.turn}마디`;
      const res = x.resolvedBy ? `, ${who(x.resolvedBy.by)}가 ${x.resolvedBy.turn}마디에 “${x.resolvedBy.quote}”` : "";
      return `- ${x.id} [${who(x.by)} · ${KIND_KO[x.kind]} · ${x.issue} · ${STATUS_KO[x.status]}${res}] ${x.text} (“${x.quote}”, ${when})`;
    })
    .join("\n");
}

/**
 * 실험 1 조건 B용 (docs/appraisal-review.md §14): 장부를 판정어 없이 "누가 무엇이라고 말했다"로 보여 준다.
 * 종류·쟁점·상태(받아들여짐·열림)를 쓰지 않는다. 1차가 정리로 기록한 말도 "이 항목에 대해 '…'라고 말함"으로만 보여 준다.
 * 그 말을 어떻게 받아들일지는 캐릭터가 정한다. 서비스의 대사 프롬프트는 이 함수를 쓰지 않는다.
 */
export function spokenLines(ledger: readonly LedgerItem[]): string {
  if (ledger.length === 0) return "- (없음)";
  const who = (s: Speaker) => (s === "player" ? "플레이어" : "너");
  const when = (t: number) => (t === 0 ? "장면 시작" : `${t}마디`);
  return ledger
    .flatMap((x) => [
      `- ${x.id} ${who(x.by)}가 ${when(x.turn)}에 말함: “${x.quote}” (${x.text})`,
      ...(x.resolvedBy ? [`  - ${who(x.resolvedBy.by)}가 ${x.resolvedBy.turn}마디에 이 항목에 대해 말함: “${x.resolvedBy.quote}”`] : []),
    ])
    .join("\n");
}

const ACT_KO: Record<PlayerAct, string> = {
  apology: "사과", request: "요청", accept: "수용", reject: "거절·반박", question: "질문", accuse: "비난·단정", explain: "사정 설명", feeling: "감정 표현", propose: "방법 제안", promise: "자기 행동 약속", other: "기타",
};

/** 이번 마디에서 확인된 사실 (대사 모델용). 지시가 아니라 기록이다. */
export function factsLines(facts: TurnFacts, ledgerAfter: readonly LedgerItem[]): string {
  const lines = facts.acts.filter((a) => a.quote).map((a) => `- 플레이어의 말 “${a.quote}”: ${ACT_KO[a.act]}${a.refersTo ? ` (${a.refersTo}에 대해)` : ""}`);
  for (const r of facts.resolved) {
    const it = ledgerAfter.find((x) => x.id === r.id);
    if (it) lines.push(`- ${r.id} “${it.text}” → ${STATUS_KO[r.status]} (${r.by === "player" ? "플레이어" : "너"}: “${r.quote}”)`);
  }
  for (const it of facts.added.filter((x) => x.by === "player")) lines.push(`- 새 항목 ${it.id}: 플레이어의 ${KIND_KO[it.kind]} “${it.text}”`);
  return lines.join("\n") || "- 새로 확인된 것 없음";
}
