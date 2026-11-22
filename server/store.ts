// Supabase(PostgREST) 저장소. relationship-engine의 저장 규칙을 따른다:
// - 필수 기록(판, 마디): 저장에 실패하면 그 마디를 화면에 보내지 않는다. 보여 준 마디는 반드시 기록에 있다.
// - 부가 기록(LLM 원문 trace): 응답 뒤에 따로 저장하고, 실패해도 결과를 바꾸지 않는다 (trace-contract §5).
// - 멱등: (play_id, idx) 고유 제약 + 요청마다 idempotency_key. 같은 키의 재전송은 처음 결과를 돌려준다.
// Supabase가 설정되지 않으면 저장 없이 동작한다 (로컬·대본 모드). 이때는 멱등 보장이 없다.
import type { AttemptRecord, LlmUsage } from "./llm.js";
import type { GameState, NpcMove, StrategyLabel, TurnFrame } from "./rules.js";

export class StoreError extends Error {}

const cfg = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
};

export const storeEnabled = () => cfg() !== null;

const STORE_TIMEOUT_MS = 6_000;

async function send(c: { url: string; key: string }, path: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STORE_TIMEOUT_MS);
  try {
    return await fetch(`${c.url}/rest/v1/${path}`, {
      method: init.method,
      signal: ctrl.signal,
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (e) {
    throw new StoreError(e instanceof Error ? e.name : "fetch_failed");
  } finally {
    clearTimeout(timer);
  }
}

/** PostgREST "없는 컬럼" 오류(PGRST204)에서 컬럼 이름을 꺼낸다. */
export function missingColumn(body: string): string | null {
  try {
    const j = JSON.parse(body) as { code?: string; message?: string };
    if (j.code !== "PGRST204") return null;
    return j.message?.match(/'([^']+)' column/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const without = (body: unknown, col: string): unknown =>
  Array.isArray(body) ? body.map((b) => without(b, col)) : body && typeof body === "object" ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== col)) : body;

/**
 * 쓰기에서 Supabase에 아직 없는 컬럼이 있으면 그 컬럼만 빼고 다시 보낸다.
 * 새 기능을 배포하고 schema.sql을 늦게 실행해도 게임이 멈추지 않게 하려는 것이다.
 * 빠진 컬럼의 값만 저장되지 않으며, 로그에 남긴다.
 */
async function rest(path: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response> {
  const c = cfg();
  if (!c) throw new StoreError("store_disabled");
  let body = init.body;
  for (let i = 0; i < 6; i++) {
    const res = await send(c, path, { ...init, body });
    if (body === undefined || res.status !== 400) return res;
    const text = await res.text();
    const col = missingColumn(text);
    if (!col) return new Response(text, { status: res.status, headers: res.headers });
    console.warn(`[store] Supabase에 '${col}' 컬럼이 없어 빼고 저장했어요. supabase/schema.sql을 다시 실행하세요.`);
    body = without(body, col);
  }
  throw new StoreError("too_many_missing_columns");
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) {
    // Supabase가 알려준 원인(예: 없는 컬럼)을 Vercel 함수 로그에 남긴다. 키나 대화 내용은 담기지 않는다.
    const body = await res.text().catch(() => "");
    let detail = body.slice(0, 300);
    try {
      const j = JSON.parse(body) as { code?: string; message?: string; hint?: string };
      detail = [j.code, j.message, j.hint].filter(Boolean).join(" | ");
    } catch {
      /* JSON이 아니면 앞부분만 */
    }
    console.warn(`[store] ${res.status} ${detail}`);
    throw new StoreError(`http_${res.status}`);
  }
  return res;
}

// ------------------------------------------------------------------ plays

export async function createPlay(state: GameState): Promise<void> {
  if (!storeEnabled()) return;
  await ok(await rest("plays", { method: "POST", prefer: "return=minimal", body: { id: state.id, heard_before: state.heardBefore, partner: state.partner ?? "m" } }));
}

export async function finishPlay(state: GameState, report: unknown): Promise<void> {
  if (!storeEnabled()) return;
  await ok(
    await rest(`plays?id=eq.${encodeURIComponent(state.id)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: {
        finished_at: new Date().toISOString(),
        outcome: state.outcome,
        final_score: state.score,
        turns_count: state.turns.length,
        chars_used: state.charsUsed,
        ending: report,
      },
    }),
  );
}

/** 이 판의 결과를 이미 저장했는지 (다시 요청돼도 finished_at을 덮어쓰지 않게). */
export async function playFinished(playId: string): Promise<boolean> {
  if (!storeEnabled()) return false;
  const res = await ok(await rest(`plays?select=finished_at&id=eq.${encodeURIComponent(playId)}`, { method: "GET" }));
  const rows = (await res.json()) as { finished_at?: string | null }[];
  return Boolean(rows[0]?.finished_at);
}

// ------------------------------------------------------------------ belief ("내가 본 너")

export async function storedBelief(playId: string): Promise<unknown | null> {
  if (!storeEnabled()) return null;
  const res = await ok(await rest(`plays?select=*&id=eq.${encodeURIComponent(playId)}`, { method: "GET" }));
  const rows = (await res.json()) as { belief?: unknown }[];
  return rows[0]?.belief ?? null;
}

export async function saveBelief(playId: string, belief: unknown): Promise<void> {
  if (!storeEnabled()) return;
  await ok(await rest(`plays?id=eq.${encodeURIComponent(playId)}`, { method: "PATCH", prefer: "return=minimal", body: { belief } }));
}

// ------------------------------------------------------------------ headline (은하 신문 1면)
// select=*: headline 컬럼이 아직 없는 DB에서도 읽기는 실패하지 않는다 (없으면 매번 새로 만든다).

export async function storedHeadline(playId: string): Promise<unknown | null> {
  if (!storeEnabled()) return null;
  const res = await ok(await rest(`plays?select=*&id=eq.${encodeURIComponent(playId)}`, { method: "GET" }));
  const rows = (await res.json()) as { headline?: unknown }[];
  return rows[0]?.headline ?? null;
}

export async function saveHeadline(playId: string, headline: unknown): Promise<void> {
  if (!storeEnabled()) return;
  await ok(await rest(`plays?id=eq.${encodeURIComponent(playId)}`, { method: "PATCH", prefer: "return=minimal", body: { headline } }));
}

/** 플레이어가 "맞아 / 좀 달라"를 고른 결과. 마지막 선택이 남는다. */
export async function saveBeliefFeedback(playId: string, verdict: "agree" | "disagree"): Promise<void> {
  if (!storeEnabled()) return;
  await ok(
    await rest(`plays?id=eq.${encodeURIComponent(playId)}`, {
      method: "PATCH",
      prefer: "return=minimal",
      body: { belief_feedback: verdict, belief_feedback_at: new Date().toISOString() },
    }),
  );
}

// ------------------------------------------------------------------ turns

export interface StoredTurn {
  idx: number;
  idempotency_key: string;
  player_text: string;
  npc_beats: { type: "narration" | "dialogue"; content: string }[];
  npc_move: NpcMove | null;
  reason?: string | null;
  noticed?: string | null;
  suggested_drop: number;
  labels: StrategyLabel[];
  state_frame?: TurnFrame | null;
}

/** 이 판에 저장된 마디들 (idx 순). 저장소가 꺼져 있으면 null. */
export async function listTurns(playId: string): Promise<StoredTurn[] | null> {
  if (!storeEnabled()) return null;
  const res = await ok(
    await rest(`turns?select=*&play_id=eq.${encodeURIComponent(playId)}&order=idx.asc`, {
      method: "GET",
    }),
  );
  return (await res.json()) as StoredTurn[];
}

/** 마디를 저장한다. 같은 (play_id, idx)가 이미 있으면 "conflict". 그 밖의 실패는 StoreError. */
export async function insertTurn(
  state: GameState,
  row: StoredTurn & { applied_drop: number; score_after: number; model: string; usage: LlmUsage | null; elapsed_ms: number; prompt_version: string },
): Promise<"ok" | "conflict" | "disabled"> {
  if (!storeEnabled()) return "disabled";
  const res = await rest("turns", { method: "POST", prefer: "return=minimal", body: { play_id: state.id, ...row } });
  if (res.status === 409) return "conflict";
  await ok(res);
  return "ok";
}

// ------------------------------------------------------------------ trace (부가 기록)

export async function saveAttempts(playId: string, callType: "npc_turn" | "belief" | "headline", turnIdx: number | null, promptVersion: string, attempts: AttemptRecord[]): Promise<void> {
  if (!storeEnabled() || attempts.length === 0) return;
  try {
    const res = await rest("llm_calls", {
      method: "POST",
      prefer: "return=minimal",
      body: attempts.map((a) => ({
        play_id: playId,
        call_type: callType,
        turn_idx: turnIdx,
        attempt: a.attempt,
        prompt_version: promptVersion,
        configured_model: a.configuredModel,
        responded_model: a.respondedModel,
        request: a.request,
        response_text: a.responseText,
        finish_reason: a.finishReason,
        usage: a.usage,
        started_at: a.startedAt,
        latency_ms: a.latencyMs,
        result: a.result,
      })),
    });
    if (!res.ok) console.warn("[trace] save failed", playId, callType, turnIdx, res.status);
  } catch (e) {
    // 원문만 누락된다. 내용은 로그에 남기지 않는다.
    console.warn("[trace] save failed", playId, callType, turnIdx, e instanceof Error ? e.message : "");
  }
}

// ------------------------------------------------------------------ stats

async function count(filter: string): Promise<number | null> {
  try {
    const res = await rest(`plays?select=id&${filter}`, { method: "HEAD", prefer: "count=exact" });
    if (!res.ok) return null;
    const n = Number(res.headers.get("content-range")?.split("/")[1]);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 끝난 판 중 가장 많이 흔든 기록(%). 없으면 null. */
async function bestShake(): Promise<number | null> {
  try {
    const res = await rest("plays?select=final_score&finished_at=not.is.null&final_score=not.is.null&order=final_score.asc&limit=1", { method: "GET" });
    if (!res.ok) return null;
    const rows = (await res.json()) as { final_score: number }[];
    const best = rows[0]?.final_score;
    return typeof best === "number" ? Math.max(0, Math.min(100, 100 - best)) : null;
  } catch {
    return null;
  }
}

export async function stats(): Promise<{ finished: number; persuaded: number; total: number; best: number | null } | null> {
  if (!storeEnabled()) return null;
  const [total, finished, persuaded, best] = await Promise.all([count("id=not.is.null"), count("finished_at=not.is.null"), count("outcome=eq.success"), bestShake()]);
  if (total === null || finished === null || persuaded === null) return null;
  return { total, finished, persuaded, best };
}
