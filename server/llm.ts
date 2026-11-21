// OpenRouter 호출 (relationship-engine과 같은 LLM Gateway).
// B에서 가져온 규칙:
// - 시도마다 하드 타임아웃 (본문을 읽는 동안에도 적용). Gateway 쪽 자동 재시도는 쓰지 않는다.
// - strict json_schema로 출력 형식을 강제하고, 받은 뒤 Zod로 다시 검증한다.
// - 자동 재시도는 1회. 실패한 시도도 원문과 함께 기록한다 (trace). API 키는 기록하지 않는다 (D-074).
// - 실패 시 대체 대사를 만들지 않는다 (D-043). 키가 없을 때만 대본 모드.
import type { CallModelConfig } from "./model-config.js";

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
}

export type FailureKind = "timeout" | "http" | "gateway_error" | "empty" | "invalid_output";

export class LlmFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly detail: string,
  ) {
    super(`${kind}:${detail}`);
  }
}

/** 시도 한 번의 기록. trace 저장용이며 결과 판단에는 쓰지 않는다. */
export interface AttemptRecord {
  attempt: number;
  configuredModel: string;
  respondedModel: string | null;
  request: unknown;
  responseText: string | null;
  finishReason: string | null;
  usage: LlmUsage | null;
  startedAt: string;
  latencyMs: number;
  result: "ok" | string;
}

export const isScripted = () => !process.env.OPENROUTER_API_KEY || process.env.SCRIPTED === "1";

export interface JsonCall {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
}

type FetchLike = typeof fetch;

/** 시도 한 번. 성공하면 원문 텍스트, 실패하면 LlmFailure. 어느 쪽이든 record를 채운다. */
export async function attemptOnce(
  cfg: CallModelConfig,
  call: JsonCall,
  attempt: number,
  fetchImpl: FetchLike = fetch,
): Promise<{ text: string; record: AttemptRecord }> {
  const request = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    temperature: cfg.temperature,
    ...(cfg.reasoningNone ? { reasoning: { effort: "none" } } : {}),
    response_format: { type: "json_schema", json_schema: { name: call.schemaName, strict: true, schema: call.schema } },
    usage: { include: true },
    messages: [
      { role: "system", content: call.system },
      { role: "user", content: call.user },
    ],
  };
  const startedAt = Date.now();
  const record: AttemptRecord = {
    attempt,
    configuredModel: cfg.model,
    respondedModel: null,
    request, // 헤더(API 키)는 담지 않는다
    responseText: null,
    finishReason: null,
    usage: null,
    startedAt: new Date(startedAt).toISOString(),
    latencyMs: 0,
    result: "ok",
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), cfg.timeoutMs);
  try {
    const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "persuasion-game",
      },
      body: JSON.stringify(request),
    });
    const raw = await res.text();
    if (!res.ok) {
      record.responseText = raw.slice(0, 2000);
      throw new LlmFailure("http", String(res.status));
    }
    const data = JSON.parse(raw) as {
      model?: string;
      error?: { code?: number | string };
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    record.respondedModel = data.model ?? null;
    record.finishReason = data.choices?.[0]?.finish_reason ?? null;
    if (data.usage) {
      record.usage = {
        promptTokens: data.usage.prompt_tokens ?? null,
        completionTokens: data.usage.completion_tokens ?? null,
        cost: data.usage.cost ?? null,
      };
    }
    if (data.error) throw new LlmFailure("gateway_error", String(data.error.code ?? "unknown"));
    const text = data.choices?.[0]?.message?.content ?? null;
    record.responseText = text;
    if (!text) throw new LlmFailure("empty", record.finishReason ?? "no_content");
    if (record.finishReason === "length") throw new LlmFailure("invalid_output", "truncated");
    return { text, record };
  } catch (e) {
    const failure =
      e instanceof LlmFailure
        ? e
        : ctrl.signal.aborted
          ? new LlmFailure("timeout", `${cfg.timeoutMs}ms`)
          : new LlmFailure("http", e instanceof Error ? e.name : "unknown");
    record.result = failure.message;
    throw Object.assign(failure, { record });
  } finally {
    clearTimeout(timer);
    record.latencyMs = Date.now() - startedAt;
  }
}

/**
 * 생성·검증을 최대 maxAttempts번 시도한다. 두 번째 시도는 남은 예산이 한 번의 타임아웃보다 클 때만.
 * parse가 throw하면 invalid_output으로 보고 다시 시도한다.
 */
export async function callWithRetry<T>(
  cfg: CallModelConfig,
  call: JsonCall,
  parse: (json: unknown, attempt: { index: number; last: boolean }) => T,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<{ ok: true; value: T; attempts: AttemptRecord[] } | { ok: false; failure: LlmFailure; attempts: AttemptRecord[] }> {
  const started = now();
  const attempts: AttemptRecord[] = [];
  let failure = new LlmFailure("empty", "not_attempted");
  for (let i = 1; i <= cfg.maxAttempts; i++) {
    if (i > 1 && now() - started + cfg.timeoutMs > cfg.budgetMs) break;
    // 다음 시도를 할 시간이 남는지로 "마지막 시도"를 판단한다. 마지막 시도에는 parse가 덜 엄격할 수 있다.
    const last = i === cfg.maxAttempts || now() - started + 2 * cfg.timeoutMs > cfg.budgetMs;
    try {
      const { text, record } = await attemptOnce(cfg, call, i, fetchImpl);
      attempts.push(record);
      try {
        return { ok: true, value: parse(extractJson(text), { index: i, last }), attempts };
      } catch (e) {
        failure = new LlmFailure("invalid_output", e instanceof Error ? e.message.slice(0, 200) : "parse");
        record.result = failure.message;
      }
    } catch (e) {
      const rec = (e as { record?: AttemptRecord }).record;
      if (rec) attempts.push(rec);
      failure = e instanceof LlmFailure ? e : new LlmFailure("http", "unknown");
    }
  }
  return { ok: false, failure, attempts };
}

/** 코드 블록으로 감싸 오는 경우까지 JSON 객체를 꺼낸다. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json");
  return JSON.parse(text.slice(start, end + 1));
}
