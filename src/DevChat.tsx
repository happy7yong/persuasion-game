import { useEffect, useRef, useState } from "react";
import { PARTNER_OPTIONS, type Partner } from "./api";

type PreviewMessage = {
  id: number;
  who: "npc" | "me" | "narration";
  text: string;
};

const initialMessages = (name: string): PreviewMessage[] => [
  {
    id: 1,
    who: "narration",
    text: `${name}가 라떼 두 잔을 내려놓고 맞은편에 앉는다.`,
  },
  {
    id: 2,
    who: "npc",
    text: "팀장님 얘기는 이따 마저 하자. 그건 진짜 열받았겠다.",
  },
  {
    id: 3,
    who: "npc",
    text: "근데 '나 무시해?'는 좀… 나 오늘 회의 네 개 연달아 들어갔어.",
  },
  {
    id: 4,
    who: "me",
    text: "아 미안, 무시한다고 한 건 좀 심했어. 근데 하루 종일 답이 없어서 나도 좀 서운했어.",
  },
  {
    id: 5,
    who: "npc",
    text: "나도 미안해. 읽고도 답을 안 한 건 네가 더 기다리게 만든 거니까.",
  },
];

const npcSamples = [
  "네가 기다린 건 알아. 내가 그건 좀 가볍게 생각했어.",
  "일할 땐 바로 답하기 어려워도, 네가 걱정한 건 그냥 넘기고 싶지 않아.",
];

export function DevChat() {
  const [partner, setPartner] = useState<Partner>("f");
  const chosen = PARTNER_OPTIONS.find((option) => option.key === partner)!;
  const [messages, setMessages] = useState<PreviewMessage[]>(() =>
    initialMessages("서아"),
  );
  const [draft, setDraft] = useState("");
  const [showKakao, setShowKakao] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const lastSeenId = useRef(5);
  const used = messages
    .filter((message) => message.who === "me")
    .reduce((sum, message) => sum + Array.from(message.text).length, 0);
  const left = Math.max(0, 600 - used);
  const count = Array.from(draft).length;
  const over = count > Math.min(300, left);
  const turns = messages.filter((message) => message.who === "me").length;

  useEffect(() => {
    const lastId = messages.at(-1)?.id ?? 0;
    if (lastId === lastSeenId.current) return;
    lastSeenId.current = lastId;
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const addMessage = (who: PreviewMessage["who"], content: string) => {
    setMessages((current) => [
      ...current,
      { id: (current.at(-1)?.id ?? 0) + 1, who, text: content },
    ]);
  };

  const send = () => {
    const content = draft.trim();
    if (!content || over || turns >= 5) return;
    addMessage("me", content);
    setDraft("");
  };

  const switchPartner = (next: Partner) => {
    setPartner(next);
    setMessages(
      initialMessages(PARTNER_OPTIONS.find((option) => option.key === next)!.name),
    );
    setDraft("");
  };

  return (
    <main className="chat dev-chat">
      <section className="dev-chat-tools" aria-label="개발용 채팅 화면 도구">
        <span className="dev-chat-tag">개발용 미리보기</span>
        <p>
          채팅 화면을 다듬는 공간이에요. 여기서 쓴 말은 저장되거나 AI에게
          전송되지 않아요.
        </p>
        <div className="dev-chat-actions">
          {PARTNER_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={`chip ${partner === option.key ? "dev-chat-selected" : "chip-quiet"}`}
              aria-pressed={partner === option.key}
              onClick={() => switchPartner(option.key)}
            >
              {option.name}
            </button>
          ))}
          <button
            type="button"
            className="chip chip-quiet"
            onClick={() =>
              addMessage("npc", npcSamples[messages.length % npcSamples.length]!)
            }
          >
            상대 대사 추가
          </button>
          <button
            type="button"
            className="chip chip-quiet"
            onClick={() =>
              addMessage("narration", `${chosen.name}가 잠깐 말을 고른다.`)
            }
          >
            지문 추가
          </button>
          <button
            type="button"
            className="chip chip-quiet"
            onClick={() => {
              setMessages(initialMessages(chosen.name));
              setDraft("");
            }}
          >
            초기화
          </button>
        </div>
      </section>

      <header className="chat-head">
        <div>
          <h1 className="chat-name">
            {chosen.label} {chosen.name}
          </h1>
          <p className="chat-place">사귄 지 1년 넘음, 금요일 밤, 동네 카페</p>
          <p className="chat-place">
            오늘 낮, 답장이 없었던 일을 두고 마주 앉아 있어요.
          </p>
        </div>
        <div className="chat-meter">
          <span className="chat-turn">{Math.min(turns + 1, 5)}/5번째 말</span>
          <div
            className="budget"
            role="meter"
            aria-label="남은 발언권"
            aria-valuemin={0}
            aria-valuemax={600}
            aria-valuenow={left}
          >
            <div className="budget-fill" style={{ width: `${(left / 600) * 100}%` }} />
          </div>
          <span className="chat-left">발언권 {left}자</span>
        </div>
      </header>

      <section className="kakao">
        <button
          type="button"
          className="kakao-toggle"
          aria-expanded={showKakao}
          onClick={() => setShowKakao((current) => !current)}
        >
          오늘 주고받은 메시지 {showKakao ? "접기" : "보기"}
        </button>
        {showKakao && (
          <ol className="kakao-list">
            <li className="kakao-row me">
              <div className="kakao-line">
                <span className="kakao-bubble">바빠?</span>
                <time>15:10</time>
              </div>
              <div className="kakao-read">읽음 15:32</div>
            </li>
            <li className="kakao-row npc">
              <div className="kakao-line">
                <span className="kakao-bubble">
                  미안 회의 연달아 있었어. 이따 카페에서 봐
                </span>
                <time>18:52</time>
              </div>
            </li>
          </ol>
        )}
      </section>

      <ol className="thread" aria-live="polite">
        {messages.map((message) =>
          message.who === "narration" ? (
            <li key={message.id} className="beat-narr">
              {message.text}
            </li>
          ) : (
            <li key={message.id} className={`bubble ${message.who}`}>
              {message.text}
            </li>
          ),
        )}
      </ol>
      <div ref={endRef} className="thread-end" />

      <div className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`${chosen.name}에게 하고 싶은 말`}
          rows={3}
          aria-label={`${chosen.name}에게 할 말`}
          aria-invalid={over}
          disabled={turns >= 5}
        />
        <div className="composer-bar">
          <span className={`count ${over ? "over" : ""}`}>
            {count}/{Math.min(300, left)}자
          </span>
          <span className="composer-key-hint">Enter는 줄바꿈</span>
          <button
            type="button"
            className="primary small"
            onClick={send}
            disabled={!draft.trim() || over || turns >= 5}
          >
            말하기
          </button>
        </div>
      </div>
    </main>
  );
}
