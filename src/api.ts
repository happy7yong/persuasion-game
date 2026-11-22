export type Beat = { type: "narration" | "dialogue"; content: string };
export type Kakao = { time: string; from: "me" | "npc"; text: string; readAt?: string };
export type Exchange = { player: string; beats: Beat[] };

/** 대화할 연인. 서버 server/content.ts의 PARTNERS와 같다 */
export type Partner = "m" | "f";
export const PARTNER_OPTIONS: { key: Partner; label: string; name: string }[] = [
  { key: "m", label: "남자친구", name: "윤재" },
  { key: "f", label: "여자친구", name: "서아" },
];

export interface StartResponse {
  token: string;
  /** Clarity 녹화와 Supabase 기록을 맞춰 보는 판 ID */
  playId: string;
  scenario: { title: string; npcName: string; partnerLabel: string; place: string; kakao: Kakao[]; opening: Beat[] };
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

/** 대화 리포트 (server/report.ts). 숫자는 모두 움직인 정도(+%) */
export interface Report {
  kind: "report";
  v: 1;
  npcName: string;
  outcome: Outcome;
  shake: number;
  successShake: number;
  turns: { turn: number; player: string; npc: Beat[]; gain: number; total: number; thought: string | null }[];
  strongestTurn: number | null;
  weakestTurn: number | null;
}

/** 대화 결과 피드백 (server/belief.ts). 실제 플레이어 발화 인용을 근거로 한다. */
export interface Belief {
  kind: "feedback";
  npcName: string;
  summary: string;
  points: { strength: string; turn: number; quote: string; improve: string; suggestion: string }[];
  closing: string;
}

/** 은하 신문 1면 (server/headline.ts) */
export interface Headline {
  kind: "headline";
  title: string;
  subtitle: string;
  quote: string;
  quoteTurn: number;
  textbook: string;
  sideArticles: string[];
}

export interface Stats {
  total: number;
  finished: number;
  persuaded: number;
  /** 지금까지 가장 많이 흔든 기록(%) */
  best: number | null;
  /** 결과 화면에서만: 끝난 판들의 움직인 % 분포 (길이 101, 인덱스 = %, 값 = 판 수) */
  distribution?: number[] | null;
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
  start: (heardBefore: boolean, partner: Partner) => post<StartResponse>("/api/start", { consent: true, heardBefore, partner }),
  turn: (token: string, message: string, key: string) => post<TurnResponse>("/api/turn", { token, message, idempotency_key: key }),
  finish: (token: string, giveup: boolean) => post<{ token: string; report: Report; stats: Stats | null }>("/api/finish", { token, ...(giveup ? { giveup: true } : {}) }),
  belief: (token: string) => post<{ belief: Belief }>("/api/belief", { token }),
  headline: (token: string) => post<{ headline: Headline }>("/api/headline", { token }),
  feedback: (token: string, verdict: "agree" | "disagree") => post<{ ok: true }>("/api/feedback", { token, verdict }),
  stats: async (): Promise<Stats | null> => {
    try {
      const res = await fetch("/api/stats");
      return ((await res.json()) as { stats: Stats | null }).stats;
    } catch {
      return null;
    }
  },
};
