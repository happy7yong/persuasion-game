import type { IncomingMessage, ServerResponse } from "node:http";

export type Req = IncomingMessage & { body?: unknown; method?: string };
export type Res = ServerResponse;

export function send(res: Res, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

export function body(req: Req): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === "object") return b as Record<string, unknown>;
  if (typeof b === "string") {
    try {
      return JSON.parse(b) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function onlyPost(req: Req, res: Res): boolean {
  if (req.method === "POST") return true;
  send(res, 405, { error: "POST만 받아요." });
  return false;
}
