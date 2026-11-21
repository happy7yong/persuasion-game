// 게임 상태를 HMAC으로 서명한 토큰. DB 없이도 클라이언트가 상태를 조작할 수 없다.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GameState } from "./rules.js";

const MAX_AGE_MS = 1000 * 60 * 60 * 6;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("SESSION_SECRET is not set (16자 이상 필요)");
  }
  return "dev-only-secret-change-me";
}

const b64 = (buf: Buffer) => buf.toString("base64url");
const sign = (body: string) => b64(createHmac("sha256", secret()).update(body).digest());

export function encodeState(state: GameState): string {
  const body = b64(Buffer.from(JSON.stringify(state), "utf8"));
  return `${body}.${sign(body)}`;
}

export function decodeState(token: unknown, now = Date.now()): GameState | null {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GameState;
    if (state.v !== 1 || now - state.startedAt > MAX_AGE_MS) return null;
    return state;
  } catch {
    return null;
  }
}
