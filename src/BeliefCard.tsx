import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Belief } from "./api";
import { track } from "./clarity";

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; belief: Belief };

const PREVIEW_FEEDBACK: Belief = {
  kind: "feedback", npcName: "윤재", summary: "상대의 한계를 받아들인 뒤 원하는 행동을 좁혀 말한 흐름이 가장 설득력 있었어요.", closing: "상대의 입장을 먼저 받아준 뒤, 내가 바라는 한 가지를 구체적으로 말해 보세요.",
  points: [
    { strength: "윤재의 업무 한계를 먼저 인정했어요", turn: 2, quote: "바로 못 보는 날이 있다는 건 이해해", improve: "그 한계가 내게 어떤 불안을 만들었는지도 함께 연결하면 좋아요.", suggestion: "바쁜 건 이해해. 다만 이유를 몰라서 내가 불안했던 건 알아줬으면 해." },
    { strength: "실제로 가능한 방법을 하나로 좁혔어요", turn: 3, quote: "이유를 먼저 말해줘", improve: "나도 바꿀 행동을 함께 말하면 일방적인 요구로 들리지 않아요.", suggestion: "너는 이유를 먼저 말해주고, 나는 걱정됐다고 말하는 걸로 해보자." },
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
      <p className="belief-desc">{npcName}가 반응한 말과, 아직 풀리지 않은 얘기를 모아뒀어요.</p>

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
          <ol className="belief-points">
            {state.belief.points.map((p, i) => (
              <li key={i}>
                <p className="belief-suggestion"><span>다음에 말해보기</span>{p.suggestion}</p>
                <p className="belief-claim">좋았던 점: {p.strength}</p>
                <button className="evidence" onClick={() => goToTurn(p.turn)} aria-label={`근거: ${p.turn}번째 말로 이동`}>
                  <span className="evidence-label">근거: {p.turn}번째 말</span>
                  <span className="evidence-quote">“{p.quote}”</span>
                </button>
                <p className="belief-why">보완할 점: {p.improve}</p>
              </li>
            ))}
          </ol>
          <p className="belief-expect">{state.belief.closing}</p>
        </>
      )}
    </section>
  );
}
