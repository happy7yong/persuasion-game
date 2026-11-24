import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Belief } from "./api";
import { track } from "./clarity";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; belief: Belief };

const PREVIEW_FEEDBACK: Belief = {
  kind: "feedback", v: 3, npcName: "윤재",
  summary: "플레이어가 바쁜 날을 이해한다고 말한 뒤 구체적인 부탁으로 이어가면서 윤재의 마음이 풀렸어요. 기다리는 동안 플레이어의 마음은 짧게 지나갔어요.",
  received: "윤재는 바쁜 날을 이해해 준 말과 나중에 이유를 알려 달라는 부탁을 받아들였어요.",
  gap: "대화는 방법을 정하는 쪽으로 이어졌지만, 답을 기다리며 느낀 감정은 처음의 ‘걱정했어’ 이후 더 이야기하지 않았어요.",
  direction: "답이 어려웠던 사정과 기다리는 동안의 감정을 함께 놓고 살펴보면 좋겠습니다.",
  evidence: [
    { turn: 2, playerQuote: "바로 못 보는 날이 있다는 건 이해해", thoughtQuote: "내 사정을 먼저 봐준 건 고맙다" },
    { turn: 3, playerQuote: "오래 비는 날엔 나중에 이유를 먼저 말해줘", thoughtQuote: "그 방법이면 나도 해볼 수 있겠다" },
  ],
};

function goToTurn(turn: number) {
  const el = document.getElementById(`turn-${turn}`);
  if (!el) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
  el.classList.add("flash");
  window.setTimeout(() => el.classList.remove("flash"), 1400);
}

export function BeliefCard({ token, npcName, preview = false }: { token: string; npcName: string; preview?: boolean }) {
  const [state, setState] = useState<State>(() => (preview ? { kind: "ready", belief: { ...PREVIEW_FEEDBACK, npcName } } : { kind: "loading" }));
  const started = useRef(false);

  const load = async () => {
    setState({ kind: "loading" });
    try {
      const { belief } = await api.belief(token);
      setState({ kind: "ready", belief });
      track("belief_shown");
    } catch (e) {
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "불러오지 못했어요." });
    }
  };

  useEffect(() => {
    if (preview) return;
    if (started.current) return;
    started.current = true;
    void load();
  }, [preview]);

  return (
    <section className="belief" aria-labelledby="belief-title" data-clarity-unmask="true">
      <h2 id="belief-title" className="belief-title">
        대화 돌아보기
      </h2>
      <p className="belief-desc">내 말 전체와 {npcName}의 속마음을 함께 돌아봤어요.</p>

      {state.kind === "loading" && (
        <div className="belief-loading" role="status">
          <span className="spinner small" aria-hidden="true" />
          대화 흐름을 정리하는 중…
        </div>
      )}

      {state.kind === "error" && (
        <div className="notice error">
          <p>{state.message}</p>
          <button className="primary small" onClick={() => void load()}>
            다시 불러오기
          </button>
        </div>
      )}

      {state.kind === "ready" && (
        <>
          <blockquote className="belief-summary">{state.belief.summary}</blockquote>
          <div className="belief-flow">
            <div>
              <h3>{npcName}에게 닿은 부분</h3>
              <p>{state.belief.received}</p>
            </div>
            <div>
              <h3>아직 남은 이야기</h3>
              <p>{state.belief.gap}</p>
            </div>
          </div>
          <div className="belief-evidence">
            <h3>대화 속 답변</h3>
            {state.belief.evidence.map((e) => (
              <button key={e.turn} className="evidence" onClick={() => goToTurn(e.turn)} aria-label={`${e.turn}번째 말로 이동`}>
                <span className="evidence-label">{e.turn}번째 말</span>
                <span className="evidence-quote">내 말 “{e.playerQuote}”</span>
                {e.thoughtQuote && <span className="evidence-thought">{npcName}의 속마음 “{e.thoughtQuote}”</span>}
              </button>
            ))}
          </div>
          <div className="belief-direction">
            <h3>다음 대화의 방향</h3>
            <p>{state.belief.direction}</p>
          </div>
        </>
      )}
    </section>
  );
}
