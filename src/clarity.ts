// Microsoft Clarity: 접속 중인 참가자 실시간 보기, 화면 녹화, 히트맵.
// VITE_CLARITY_ID가 없으면 아무것도 하지 않는다 (로컬 개발 등).
// 채팅 말풍선은 data-clarity-unmask로 녹화에 보이게 한다. 입력창 내용은 Clarity가 항상 가린다.

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
declare global {
  interface Window {
    clarity?: ClarityFn;
  }
}

const ID = import.meta.env.VITE_CLARITY_ID as string | undefined;

export function initClarity(): void {
  if (!ID || typeof window === "undefined" || window.clarity) return;
  // Clarity 공식 설치 코드와 같은 동작: 스크립트가 오기 전 호출은 큐에 쌓아 둔다.
  const c: ClarityFn = (...args: unknown[]) => {
    (c.q = c.q || []).push(args);
  };
  window.clarity = c;
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.clarity.ms/tag/${encodeURIComponent(ID)}`;
  document.head.appendChild(s);
}

const call = (...args: unknown[]) => {
  try {
    window.clarity?.(...args);
  } catch {
    /* 분석 도구 오류가 게임을 막지 않게 */
  }
};

/** 녹화를 Supabase 기록(plays.id)과 맞춰 볼 수 있게 판 ID를 붙인다. */
export const tagPlay = (playId: string) => {
  call("set", "play_id", playId);
  call("identify", playId);
};
export const tag = (key: string, value: string) => call("set", key, value);
export const track = (event: string) => call("event", event);
