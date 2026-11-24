// 결과 맨 위 카드: 결과 이름, 마음이 통한 %, 설득 성공선 게이지, 한 줄 설명.
// 내 결과 화면(Report)과, 공유 링크로 들어온 첫 화면(친구의 결과)에서 같이 쓴다.
import { useEffect, useState, type ReactNode } from "react";
import type { Outcome } from "./api";

// 연인 이름은 모두 받침이 없어 조사가 같다 (server/content.ts PARTNERS)
export const OUTCOME: Record<Outcome, { name: string; note: (npc: string) => string }> = {
  success: { name: "설득 성공", note: (n) => `내 서운함도 전해졌고, ${n}도 마음을 열었어요.` },
  compromise: { name: "타협", note: () => "분위기는 풀렸지만, 내 마음은 다 전하지 못했어요." },
  breakdown: { name: "결렬", note: () => "서로 마음이 엇갈렸어요." },
  giveup: { name: "포기", note: () => "대화를 중간에 멈췄어요." },
};

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useCountUp(to: number): number {
  const [n, setN] = useState(reduceMotion() ? to : 0);
  useEffect(() => {
    if (reduceMotion()) return setN(to);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / 1200);
      setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to]);
  return n;
}

export function ResultSummary({
  npcName,
  outcome,
  shake,
  successShake,
  who = "me",
  children,
}: {
  npcName: string;
  outcome: Outcome;
  shake: number;
  successShake: number;
  /** me: 내 결과, friend: 공유 링크로 받은 친구의 결과 */
  who?: "me" | "friend";
  /** 카드 아래쪽에 덧붙일 내용 (최고 기록 등) */
  children?: ReactNode;
}) {
  const shown = useCountUp(shake);
  const friend = who === "friend";
  // 첫 화면에는 이미 제목(h1)이 있어서 친구 결과는 h2로 둔다
  const Title = friend ? "h2" : "h1";
  return (
    <section className={`report-summary ${friend ? "shared-summary" : ""}`} aria-label={friend ? "친구의 결과" : "내 결과"}>
      {friend && <p className="shared-label">친구가 보낸 결과</p>}
      <p className={`report-outcome ${outcome}`}>{OUTCOME[outcome].name}</p>
      <Title className="report-title">
        {friend ? "친구는 " : ""}
        {npcName}와
        <span className="report-title-result">
          <span className="report-number">{shown}%</span>
          <span>통했어요</span>
        </span>
      </Title>
      <div className="meter" role="meter" aria-label={`${npcName}와 마음이 통한 정도`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={shake}>
        <div className="meter-fill" style={{ width: `${shown}%` }} />
        <div className="meter-goal" style={{ left: `${successShake}%` }}>
          <span>설득 성공 {successShake}%</span>
        </div>
      </div>
      <p className="report-note">
        {friend ? (
          <>당신은 {npcName}와 몇 % 통할 수 있을까요?</>
        ) : (
          <>
            {OUTCOME[outcome].note(npcName)}
            {outcome !== "success" && shake < successShake && ` 성공까지 ${successShake - shake}% 남았어요.`}
          </>
        )}
      </p>
      {children}
    </section>
  );
}
