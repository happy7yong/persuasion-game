// 게임 상태 토큰. AES-256-GCM으로 암호화하므로 클라이언트는 상태를 읽을 수도(숨긴 마음 지수 포함),
// 바꿀 수도 없다. 바꾸면 인증 태그가 맞지 않아 거부된다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { GameState } from "./rules.js";

export const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 6;

function key(): Buffer {
  let s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV) throw new Error("SESSION_SECRET is not set (16자 이상 필요)");
    s = "dev-only-secret-change-me";
  }
  return createHash("sha256").update(`persuasion-game/token/v2:${s}`).digest();
}

export function encodeState(state: GameState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  return ["v2", iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decodeState(token: unknown, now = Date.now()): GameState | null {
  if (typeof token !== "string" || token.length > 64_000) return null;
  const [v, iv, body, tag] = token.split(".");
  if (v !== "v2" || !iv || !body || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const json = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
    const state = JSON.parse(json) as GameState;
    if (state.v !== 1 || now - state.startedAt > TOKEN_MAX_AGE_MS) return null;
    return state;
  } catch {
    return null;
  }
}
