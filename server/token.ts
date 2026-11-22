// 게임 상태 토큰. AES-256-GCM으로 암호화하므로 클라이언트는 상태를 읽을 수도(숨긴 마음 지수 포함),
// 바꿀 수도 없다. 바꾸면 인증 태그가 맞지 않아 거부된다.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { newGame, type GameState } from "./rules.js";

export const TOKEN_MAX_AGE_MS = 1000 * 60 * 60 * 6;

function key(): Buffer {
  let s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV) throw new Error("SESSION_SECRET is not set (16자 이상 필요)");
    s = "dev-only-secret-change-me";
  }
  return createHash("sha256").update(`persuasion-game/token/v2:${s}`).digest();
}

/**
 * v3: JSON을 압축한 뒤 암호화한다. 장부·마디별 사실이 쌓이면 한국어 JSON이 커져서(글자당 약 4자),
 * 압축 없이(v2)는 다섯 마디째에 길이 상한에 닿을 수 있다. 압축은 반복되는 키 덕분에 여러 배 줄인다.
 */
export function encodeState(state: GameState): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(deflateRawSync(Buffer.from(JSON.stringify(state), "utf8"))), cipher.final()]);
  return ["v3", iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

export function decodeState(token: unknown, now = Date.now()): GameState | null {
  if (typeof token !== "string" || token.length > 64_000) return null;
  const [v, iv, body, tag] = token.split(".");
  // v2(압축 없음)는 이 변경 전에 시작한 판의 토큰이다. 같은 판 안에서는 계속 읽는다.
  if ((v !== "v2" && v !== "v3") || !iv || !body || !tag) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
    // 인증 태그를 통과한 서버 자신의 데이터만 푼다. 그래도 풀린 크기에 상한을 둔다.
    const json = (v === "v3" ? inflateRawSync(plain, { maxOutputLength: 2_000_000 }) : plain).toString("utf8");
    const state = JSON.parse(json) as GameState;
    if (state.v !== 1 || now - state.startedAt > TOKEN_MAX_AGE_MS) return null;
    // 장부 도입 전 토큰도 같은 판 안에서는 이어갈 수 있게 초기 장부·마음을 채운다 (예전 관계 상태는 버린다).
    if (!Array.isArray(state.ledger) || !state.currentMind) {
      const initial = newGame(state.id, state.startedAt, state.heardBefore, state.partner ?? "m");
      return { ...state, currentMind: initial.currentMind, ledger: initial.ledger, progress: [] };
    }
    if (!Array.isArray(state.progress)) state.progress = [];
    return state;
  } catch {
    return null;
  }
}
