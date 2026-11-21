export type Beat = { type: "narration" | "dialogue"; content: string };
export type Kakao = { time: string; from: "me" | "npc"; text: string; readAt?: string };

export interface StartResponse {
  token: string;
  scenario: { title: string; npcName: string; place: string; kakao: Kakao[]; opening: Beat[] };
  rules: { maxTurns: number; charBudget: number; messageMax: number };
}

export interface TurnResponse {
  token: string;
  beats: Beat[];
  turnsUsed: number;
  charsLeft: number;
  finished: boolean;
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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly expired: boolean,
  ) {
    super(message);
  }
}

async function post<T>(path: string, data: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
  } catch {
    throw new ApiError("인터넷 연결을 확인하고 다시 시도해 주세요.", true, false);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; retryable?: boolean; expired?: boolean };
  if (!res.ok) throw new ApiError(json.error ?? "문제가 생겼어요. 다시 시도해 주세요.", json.retryable ?? res.status >= 500, json.expired ?? false);
  return json as T;
}

export const api = {
  start: (consent: boolean, heardBefore: boolean) => post<StartResponse>("/api/start", { consent, heardBefore }),
  turn: (token: string, message: string) => post<TurnResponse>("/api/turn", { token, message }),
  finish: (token: string, giveup: boolean) => post<{ token: string; ending: Ending; stats: Stats | null }>("/api/finish", { token, giveup }),
  stats: async (): Promise<Stats | null> => {
    try {
      const res = await fetch("/api/stats");
      return ((await res.json()) as { stats: Stats | null }).stats;
    } catch {
      return null;
    }
  },
};
