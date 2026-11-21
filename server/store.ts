// Supabase(PostgREST) 저장소. relationship-engine의 저장 규칙을 따른다:
// - 필수 기록(판, 마디): 저장에 실패하면 그 마디를 화면에 보내지 않는다. 보여 준 마디는 반드시 기록에 있다.
// - 부가 기록(LLM 원문 trace): 응답 뒤에 따로 저장하고, 실패해도 결과를 바꾸지 않는다 (trace-contract §5).
// - 멱등: (play_id, idx) 고유 제약 + 요청마다 idempotency_key. 같은 키의 재전송은 처음 결과를 돌려준다.
// Supabase가 설정되지 않으면 저장 없이 동작한다 (로컬·대본 모드). 이때는 멱등 보장이 없다.
import type { AttemptRecord, LlmUsage } from "./llm.js";
import type { GameState, NpcMove, StrategyLabel } from "./rules.js";

export class StoreError extends Error {}

const cfg = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
};

export const storeEnabled = () => cfg() !== null;

const STORE_TIMEOUT_MS = 6_000;

async function rest(path: string, init: { method: string; body?: unknown; prefer?: string }): Promise<Response> {
  const c = cfg();
  if (!c) throw new StoreError("store_disabled");
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

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new StoreError(`http_${res.status}`);
  return res;
}

// ------------------------------------------------------------------ plays

export async function createPlay(state: GameState): Promise<void> {
  if (!storeEnabled()) return;
  await ok(await rest("plays", { method: "POST", prefer: "return=minimal", body: { id: state.id, heard_before: state.heardBefore } }));
}

export async function finishPlay(state: GameState, ending: unknown, endingModel: string, endingUsage: LlmUsage | null): Promise<void> {
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
        ending_model: endingModel,
        ending_usage: endingUsage,
        ending,
      },
    }),
  );
}

export async function storedEnding(playId: string): Promise<unknown | null> {
  if (!storeEnabled()) return null;
  const res = await ok(await rest(`plays?select=ending&id=eq.${encodeURIComponent(playId)}`, { method: "GET" }));
  const rows = (await res.json()) as { ending?: unknown }[];
  return rows[0]?.ending ?? null;
}

// ------------------------------------------------------------------ turns

export interface StoredTurn {
  idx: number;
  idempotency_key: string;
  player_text: string;
  npc_beats: { type: "narration" | "dialogue"; content: string }[];
  npc_move: NpcMove | null;
  suggested_drop: number;
  labels: StrategyLabel[];
}

/** 이 판에 저장된 마디들 (idx 순). 저장소가 꺼져 있으면 null. */
export async function listTurns(playId: string): Promise<StoredTurn[] | null> {
  if (!storeEnabled()) return null;
  const res = await ok(
    await rest(`turns?select=idx,idempotency_key,player_text,npc_beats,npc_move,suggested_drop,labels&play_id=eq.${encodeURIComponent(playId)}&order=idx.asc`, {
      method: "GET",
    }),
  );
  return (await res.json()) as StoredTurn[];
}

/** 마디를 저장한다. 같은 (play_id, idx)가 이미 있으면 "conflict". 그 밖의 실패는 StoreError. */
export async function insertTurn(
  state: GameState,
  row: StoredTurn & { applied_drop: number; score_after: number; reason: string; model: string; usage: LlmUsage | null; elapsed_ms: number; prompt_version: string },
): Promise<"ok" | "conflict" | "disabled"> {
  if (!storeEnabled()) return "disabled";
  const res = await rest("turns", { method: "POST", prefer: "return=minimal", body: { play_id: state.id, ...row } });
  if (res.status === 409) return "conflict";
  await ok(res);
  return "ok";
}

// ------------------------------------------------------------------ trace (부가 기록)

export async function saveAttempts(playId: string, callType: "npc_turn" | "ending", turnIdx: number | null, promptVersion: string, attempts: AttemptRecord[]): Promise<void> {
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

export async function stats(): Promise<{ finished: number; persuaded: number; total: number } | null> {
  if (!storeEnabled()) return null;
  const [total, finished, persuaded] = await Promise.all([count("id=not.is.null"), count("finished_at=not.is.null"), count("outcome=eq.success")]);
  if (total === null || finished === null || persuaded === null) return null;
  return { total, finished, persuaded };
}
