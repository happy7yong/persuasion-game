// 선택 기능: Supabase REST로 대화 로그 저장. 설정이 없거나 실패해도 게임은 계속된다.
import type { GameState, TurnRecord } from "./rules.js";
import type { LlmUsage } from "./llm.js";

const cfg = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
};

export const loggingEnabled = () => cfg() !== null;

async function rest(path: string, init: RequestInit & { prefer?: string }): Promise<Response | null> {
  const c = cfg();
  if (!c) return null;
  try {
    return await fetch(`${c.url}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: c.key,
        Authorization: `Bearer ${c.key}`,
        "Content-Type": "application/json",
        ...(init.prefer ? { Prefer: init.prefer } : {}),
      },
    });
  } catch {
    return null;
  }
}

export async function logStart(state: GameState): Promise<void> {
  await rest("plays", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({ id: state.id, heard_before: state.heardBefore }),
  });
}

export async function logTurn(state: GameState, turn: TurnRecord, extra: { reason: string; model: string; usage: LlmUsage | null; elapsedMs: number }): Promise<void> {
  await rest("turns", {
    method: "POST",
    prefer: "return=minimal",
    body: JSON.stringify({
      play_id: state.id,
      idx: state.turns.length,
      player_text: turn.player,
      npc_beats: turn.npc,
      suggested_drop: turn.suggested,
      applied_drop: turn.applied,
      labels: turn.labels,
      reason: extra.reason,
      score_after: turn.scoreAfter,
      model: extra.model,
      usage: extra.usage,
      elapsed_ms: extra.elapsedMs,
    }),
  });
}

/** 같은 토큰으로 같은 마디를 다시 보내는 재사용을 막는다. 로그가 없으면 null(검사 생략). */
export async function storedTurnCount(playId: string): Promise<number | null> {
  const res = await rest(`turns?select=id&play_id=eq.${encodeURIComponent(playId)}`, { method: "HEAD", prefer: "count=exact" });
  if (!res || !res.ok) return null;
  const n = Number(res.headers.get("content-range")?.split("/")[1]);
  return Number.isFinite(n) ? n : null;
}

/** 이미 만든 엔딩이 있으면 돌려준다. 엔딩 생성 비용이 반복해서 나가지 않게 한다. */
export async function storedEnding(playId: string): Promise<unknown | null> {
  const res = await rest(`plays?select=ending&id=eq.${encodeURIComponent(playId)}`, { method: "GET" });
  if (!res || !res.ok) return null;
  const rows = (await res.json().catch(() => [])) as { ending?: unknown }[];
  return rows[0]?.ending ?? null;
}

export async function logFinish(state: GameState, extra: { endingModel: string; endingUsage: LlmUsage | null; ending: unknown }): Promise<void> {
  await rest(`plays?id=eq.${encodeURIComponent(state.id)}`, {
    method: "PATCH",
    prefer: "return=minimal",
    body: JSON.stringify({
      finished_at: new Date().toISOString(),
      outcome: state.outcome,
      final_score: state.score,
      turns_count: state.turns.length,
      chars_used: state.charsUsed,
      ending_model: extra.endingModel,
      ending_usage: extra.endingUsage,
      ending: extra.ending,
    }),
  });
}

async function count(filter: string): Promise<number | null> {
  const res = await rest(`plays?select=id&${filter}`, { method: "HEAD", prefer: "count=exact" });
  if (!res || !res.ok) return null;
  const range = res.headers.get("content-range");
  const n = range ? Number(range.split("/")[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function stats(): Promise<{ finished: number; persuaded: number; total: number } | null> {
  if (!loggingEnabled()) return null;
  const [total, finished, persuaded] = await Promise.all([count("id=not.is.null"), count("finished_at=not.is.null"), count("outcome=eq.success")]);
  if (total === null || finished === null || persuaded === null) return null;
  return { total, finished, persuaded };
}
