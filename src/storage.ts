// 새로고침해도 판을 이어 하도록 sessionStorage에 저장한다. 탭을 닫으면 사라진다.
// 저장된 값은 화면 표시용 사본이다. 판의 진짜 상태는 서버가 암호화한 토큰에 있다.
import type { Beat, Report, StartResponse, Stats } from "./api";

export type Msg = { id: number; who: "npc" | "me"; beat: Beat };

export interface SavedGame {
  v: 1;
  game: StartResponse;
  token: string;
  msgs: Msg[];
  turns: number;
  left: number;
  finished: boolean;
  ending: { data: Report; stats: Stats | null } | null;
}

// v2: 결과가 은하 엔딩에서 대화 리포트로 바뀜. 예전 저장분은 읽지 않는다.
const KEY = "persuasion-game:v2";

export function loadGame(): SavedGame | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as SavedGame;
    return g.v === 1 && g.token && g.game ? g : null;
  } catch {
    return null;
  }
}

export function saveGame(g: SavedGame): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(g));
  } catch {
    /* 저장 공간이 없거나 막힌 브라우저: 새로고침 복구만 안 된다 */
  }
}

export function clearGame(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* 무시 */
  }
}
