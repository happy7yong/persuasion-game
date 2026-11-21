// 요청·오류 형식 (relationship-engine api.md §2.4).
// 오류는 항상 { error: { code, message, retryable } }. 거부된 요청은 어떤 상태도 바꾸지 않는다.
// 입력 검증 오류는 입력값을 되돌려 보내지 않는다.
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";

export type Req = IncomingMessage & { body?: unknown; method?: string };
export type Res = ServerResponse;

export const ERROR_CODES = [
  "invalid_request", // 400 본문 형식·길이 오류
  "session_expired", // 400 토큰이 없거나 만료·변조
  "invalid_turn_state", // 409 끝난 판에 말하기, 안 끝난 판에 결과 요청
  "turn_already_recorded", // 409 그 마디는 이미 다른 말로 기록됨 (resync 포함)
  "idempotency_key_reused", // 409 이미 지나간 마디의 키
  "generation_failed", // 502 LLM 생성·검증 실패 (자동 재시도 후). 상태 변화 없음
  "service_unavailable", // 503 저장소 장애
  "closed", // 503 준비한 판이 모두 끝남
  "internal_error", // 500
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  session_expired: 400,
  invalid_turn_state: 409,
  turn_already_recorded: 409,
  idempotency_key_reused: 409,
  generation_failed: 502,
  service_unavailable: 503,
  closed: 503,
  internal_error: 500,
};

const RETRYABLE: Record<ErrorCode, boolean> = {
  invalid_request: false,
  session_expired: false,
  invalid_turn_state: false,
  turn_already_recorded: false,
  idempotency_key_reused: false,
  generation_failed: true,
  service_unavailable: true,
  closed: false,
  internal_error: true,
};

export function send(res: Res, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export function fail(res: Res, code: ErrorCode, message: string, extra?: Record<string, unknown>): void {
  send(res, STATUS[code], { error: { code, message, retryable: RETRYABLE[code] }, ...extra });
}

function rawBody(req: Req): unknown {
  const b = req.body;
  if (typeof b === "string") {
    try {
      return JSON.parse(b);
    } catch {
      return undefined;
    }
  }
  return b;
}

/** 메서드와 본문을 검사한다. 실패하면 응답을 보내고 null. */
export function parseRequest<T extends z.ZodTypeAny>(req: Req, res: Res, schema: T): z.infer<T> | null {
  if (req.method !== "POST") {
    fail(res, "invalid_request", "POST만 받아요.");
    return null;
  }
  const r = schema.safeParse(rawBody(req));
  if (!r.success) {
    fail(res, "invalid_request", "요청 형식이 올바르지 않아요.", { issues: r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })) });
    return null;
  }
  return r.data;
}

/** 예기치 못한 오류를 internal_error로 바꾼다. 내용은 서버 로그에만 남긴다. */
export function guarded(handler: (req: Req, res: Res) => Promise<void>) {
  return async (req: Req, res: Res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error("[api] unexpected", e instanceof Error ? e.message : e);
      if (!res.headersSent) fail(res, "internal_error", "잠시 문제가 생겼어요. 다시 시도해 주세요.");
    }
  };
}

export const IdempotencyKey = z.string().uuid();
