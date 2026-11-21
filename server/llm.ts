// OpenRouter 호출 (relationship-engine과 같은 LLM Gateway). 키가 없으면 대본 모드.

export interface LlmUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cost: number | null;
}

export interface LlmResult {
  text: string;
  model: string;
  usage: LlmUsage;
}

export const isScripted = () => !process.env.OPENROUTER_API_KEY || process.env.SCRIPTED === "1";

export async function callJson(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<LlmResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 40_000);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "persuasion-game",
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature ?? 0.8,
        response_format: { type: "json_object" },
        usage: { include: true },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`llm_http_${res.status}`);
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("llm_empty");
    return {
      text,
      model: data.model ?? opts.model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? null,
        completionTokens: data.usage?.completion_tokens ?? null,
        cost: data.usage?.cost ?? null,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 코드 블록으로 감싸 오는 경우까지 JSON 객체를 꺼낸다. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no_json");
  return JSON.parse(text.slice(start, end + 1));
}
