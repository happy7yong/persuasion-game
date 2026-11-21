export type Beat = { type: "narration" | "dialogue"; content: string };
export type Kakao = { time: string; from: "me" | "npc"; text: string; readAt?: string };
export type Exchange = { player: string; beats: Beat[] };

export interface StartResponse {
  token: string;
  /** Clarity 녹화와 Supabase 기록을 맞춰 보는 판 ID */
  playId: string;
  scenario: { title: string; npcName: string; place: string; kakao: Kakao[]; opening: Beat[] };
  rules: { maxTurns: number; charBudget: number; messageMax: number };
}

export interface Progress {
  token: string;
  turnsUsed: number;
  charsLeft: number;
  finished: boolean;
}

export interface TurnResponse extends Progress {
  exchanges: Exchange[];
  replayed: boolean;
}

export type Outcome = "success" | "compromise" | "breakdown" | "giveup";

export interface Ending {
  plan: {
    outcome: Outcome;
    shake: number;
    lines: { turn: number; text: string; drop: number }[];
    strongestTurn: number | null;
    weakestTurn: number | null;
    forks: { era: string; basis: string; chosen: string; untaken: string[]; decidingTurn: number | null }[];
  };
  chains: { turn: number; line: string; drop: number; events: { year: number; text: string }[] }[];
  headline: { title: string; subtitle: string; quote: string };
  textbook: string;
  sideArticles: string[];
  untaken: { instead: string; events: string[] };
}

export interface Stats {
  total: number;
  finished: number;
  persuaded: number;
}

/** 서버 오류 형식 { error: { code, message, retryable } } (relationship-engine api.md §2.4) */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly resync: (Progress & { exchanges: Exchange[] }) | null = null,
  ) {
    super(message);
  }
}

async function post<T>(path: string, data: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  } catch {
    throw new ApiError("network", "인터넷 연결을 확인하고 다시 보내 주세요.", true);
  }
  const json = (await res.json().catch(() => null)) as
    | ({ error?: { code?: string; message?: string; retryable?: boolean }; resync?: Progress & { exchanges: Exchange[] } } & Record<string, unknown>)
    | null;
  if (!res.ok || !json) {
    const e = json?.error;
    throw new ApiError(e?.code ?? "unknown", e?.message ?? "문제가 생겼어요. 다시 시도해 주세요.", e?.retryable ?? res.status >= 500, json?.resync ?? null);
  }
  return json as T;
}

export const newKey = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16));

export const api = {
  start: (heardBefore: boolean) => post<StartResponse>("/api/start", { consent: true, heardBefore }),
  turn: (token: string, message: string, key: string) => post<TurnResponse>("/api/turn", { token, message, idempotency_key: key }),
  finish: (token: string, giveup: boolean) => post<{ token: string; ending: Ending; stats: Stats | null }>("/api/finish", { token, ...(giveup ? { giveup: true } : {}) }),
  stats: async (): Promise<Stats | null> => {
    try {
      const res = await fetch("/api/stats");
      return ((await res.json()) as { stats: Stats | null }).stats;
    } catch {
      return null;
    }
  },
};
