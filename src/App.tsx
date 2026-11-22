import { useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  newKey,
  PARTNER_OPTIONS,
  type Beat,
  type Exchange,
  type Partner,
  type Report,
  type StartResponse,
  type Stats,
} from "./api";
import { ReportView } from "./Report";
import { GiveupDialog } from "./GiveupDialog";
import { ResultSummary } from "./ResultSummary";
import { clearSharedParams, DEV_SHARED, readSharedResult, type SharedResult } from "./share";
import { sampleDistribution } from "./rank";
import { tag, tagPlay, track } from "./clarity";
import {
  clearGame,
  loadGame,
  saveGame,
  type Msg,
  type SavedGame,
} from "./storage";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const chars = (s: string) => Array.from(s).length;
const INTRO_TITLE = "우리 얘기 좀 해";
const DEV_REPORT: Report = {
  kind: "report",
  v: 1,
  npcName: "윤재",
  outcome: "compromise",
  shake: 63,
  successShake: 70,
  strongestTurn: 3,
  weakestTurn: 1,
  turns: [
    {
      turn: 1,
      player: "8시간 동안 연락이 안 돼서 걱정했어.",
      npc: [
        {
          type: "dialogue",
          content: "걱정한 건 알겠어. 일부러 피한 건 아니야.",
        },
      ],
      gain: 6,
      total: 6,
      thought: "걱정하게 만든 건 미안한데, 내 의도도 알아줬으면 해.",
    },
    {
      turn: 2,
      player: "일할 때 바로 못 보는 날이 있다는 건 이해해.",
      npc: [{ type: "dialogue", content: "그렇게 말해주니까 나도 좀 풀린다." }],
      gain: 14,
      total: 20,
      thought: "내 사정을 먼저 봐준 건 고맙다.",
    },
    {
      turn: 3,
      player: "오래 비는 날엔 나중에 이유를 먼저 말해줘.",
      npc: [{ type: "dialogue", content: "그 정도는 내가 먼저 말할게." }],
      gain: 18,
      total: 38,
      thought: "그 방법이면 나도 해볼 수 있겠다.",
    },
    {
      turn: 4,
      player: "나는 무시한다고 몰아붙이지 않고 걱정됐다고 말할게.",
      npc: [
        { type: "dialogue", content: "그럼 나도 답이 늦은 이유부터 말할게." },
      ],
      gain: 14,
      total: 52,
      thought: "서로 할 수 있는 쪽으로 말하니까 납득이 간다.",
    },
    {
      turn: 5,
      player: "오늘은 밥 먹으면서 더 얘기하자.",
      npc: [{ type: "dialogue", content: "그래. 나도 배고팠어." }],
      gain: 11,
      total: 63,
      thought: "당장 다 끝내진 않아도 같이 풀어가면 되겠다.",
    },
  ],
};

export function App() {
  const [session, setSession] = useState<SavedGame | null>(() => loadGame());
  const [stats, setStats] = useState<Stats | null>(null);
  // 공유 링크로 들어왔으면 첫 화면에 친구의 결과를 보여 준다. ?dev=shared 는 개발자용 예시.
  const [shared] = useState<SharedResult | null>(() =>
    import.meta.env.DEV && new URLSearchParams(window.location.search).get("dev") === "shared"
      ? DEV_SHARED
      : readSharedResult()
  );

  useEffect(() => {
    if (shared) track("shared_link_opened");
  }, []);

  useEffect(() => {
    if (!session) void api.stats().then(setStats);
  }, [session === null]);

  useEffect(() => {
    if (session) saveGame(session);
  }, [session]);

  useEffect(() => {
    if (session?.game.playId) tagPlay(session.game.playId);
  }, [session?.game.playId]);

  const developerPreview =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("dev") === "result";
  if (developerPreview) {
    return (
      <>
        <ReportView
          report={DEV_REPORT}
          stats={{ total: 18, finished: 18, persuaded: 7, best: 71, distribution: sampleDistribution() }}
          token=""
          preview
          onRetry={() => window.location.assign(window.location.pathname)}
        />
        <AppFooter showDesignNotes />
      </>
    );
  }

  const restart = () => {
    clearGame();
    setSession(null);
    window.scrollTo({ top: 0 });
  };

  if (!session) {
    return (
      <>
        <Intro
          stats={stats}
          shared={shared}
          onStart={(g) =>
            setSession({
              v: 1,
              game: g,
              token: g.token,
              msgs: [],
              turns: 0,
              left: g.rules.charBudget,
              finished: false,
              ending: null,
            })
          }
        />
        <AppFooter />
      </>
    );
  }
  if (session.ending) {
    return (
      <>
        <ReportView
          report={session.ending.data}
          stats={session.ending.stats}
          token={session.token}
          onRetry={restart}
        />
        <AppFooter showDesignNotes />
      </>
    );
  }
  return (
    <>
      <Chat
        session={session}
        update={(patch) => setSession((s) => (s ? { ...s, ...patch } : s))}
        onRestart={restart}
      />
      <AppFooter />
    </>
  );
}

function AppFooter({ showDesignNotes = false }: { showDesignNotes?: boolean }) {
  return (
    <>
      {showDesignNotes && (
        <aside className="design-notes" aria-label="피드백 설계 참고">
          <p className="design-notes-title">설계 참고</p>
          <p>
            이 피드백은 관계를 진단하거나 정답을 판정하지 않아요. 실제 발화와
            상대가 유지한 입장을 바탕으로 대화의 흐름을 돌아보기 위한 장치예요.
          </p>
          <ul>
            <li>
              <a
                href="https://academic.oup.com/edited-volume/38162/chapter/332989072"
                target="_blank"
                rel="noreferrer"
              >
                파트너 반응성
              </a>{" "}
              — 이해, 인정, 돌봄이 관계 경험에 미치는 과정
            </li>
            <li>
              <a
                href="https://doi.org/10.1037/0033-2909.119.2.254"
                target="_blank"
                rel="noreferrer"
              >
                Kluger &amp; DeNisi (1996)
              </a>{" "}
              — 사람 자체보다 행동과 과제에 초점을 둔 피드백
            </li>
            <li>
              <a
                href="https://www.tandfonline.com/doi/full/10.1080/08975353.2015.1038962"
                target="_blank"
                rel="noreferrer"
              >
                Gottman et al.
              </a>{" "}
              — 갈등에서 공격과 방어를 협력으로 돌리는 repair 과정
            </li>
          </ul>
        </aside>
      )}
      <footer className="app-footer">
        문의:{" "}
        <a href="mailto:chaeyoung7742@gmail.com">chaeyoung7742@gmail.com</a>
      </footer>
    </>
  );
}

function Intro({
  stats,
  shared,
  onStart,
}: {
  stats: Stats | null;
  shared: SharedResult | null;
  onStart: (g: StartResponse) => void;
}) {
  // 친구가 대화한 연인을 미리 골라 둔다 (바꿀 수 있다)
  const [partner, setPartner] = useState<Partner | null>(shared?.partner ?? null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = PARTNER_OPTIONS.find((o) => o.key === partner);

  const start = async () => {
    if (!partner) return setError("대화할 연인을 골라 주세요.");
    if (!consent) return setError("시작하려면 대화 기록 활용에 동의해 주세요.");
    setBusy(true);
    setError("");
    try {
      const game = await api.start(false, partner);
      clearSharedParams();
      onStart(game);
      track("game_started");
      tag("partner", partner);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.message
          : "문제가 생겼어요. 다시 시도해 주세요."
      );
      setBusy(false);
    }
  };

  return (
    <main className="intro">
      <div className="intro-card">
        {shared && (
          <ResultSummary
            who="friend"
            npcName={shared.npcName}
            outcome={shared.outcome}
            shake={shared.shake}
            successShake={shared.successShake}
          />
        )}
        <p className="intro-scene">
          <svg
            className="intro-scene-letter"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <rect x="3" y="5" width="18" height="14" rx="2.2" />
            <path d="m4.5 7 7.5 5.7L19.5 7" />
          </svg>
          <span>금요일 밤, 동네 카페</span>
        </p>
        <h1 className="intro-title" aria-label={INTRO_TITLE}>
          {Array.from(INTRO_TITLE).map((letter, i) =>
            letter === " " ? (
              <span key={i} className="intro-title-space" aria-hidden="true" />
            ) : (
              <span key={i} className="intro-title-mask" aria-hidden="true">
                <span
                  className="intro-title-letter"
                  style={{ animationDelay: `${140 + i * 58}ms` }}
                >
                  {letter}
                </span>
              </span>
            )
          )}
        </h1>
        <p className="intro-lede">
          오늘 하루 종일 연락이 없던 연인{chosen ? ` ${chosen.name}` : ""}.
          <br />
          다섯 마디 안에 마음을 돌릴 수 있을까요?
        </p>
        <fieldset className="partner">
          <legend>누구와 이야기할까요?</legend>
          <div className="partner-options">
            {PARTNER_OPTIONS.map((o) => (
              <label
                key={o.key}
                className={`partner-option ${partner === o.key ? "on" : ""}`}
              >
                <input
                  type="radio"
                  name="partner"
                  value={o.key}
                  checked={partner === o.key}
                  onChange={() => (setPartner(o.key), setError(""))}
                />
                <span className="partner-label">{o.label}</span>
                <span className="partner-name">{o.name}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="intro-count" aria-live="polite">
          {stats && stats.best !== null ? (
            <>
              연인의 마음을 가장 많이 흔든 기록은 <strong>{stats.best}%</strong>
              <span className="intro-count-sub">
                벌써 <b>{stats.finished}명</b>이 도전했어요. 과연 연인의 마음을 얼마나 움직일 수 있을까요?
              </span>
            </>
          ) : (
            <>아직 기록이 없어요. 첫 기록을 세워 보세요.</>
          )}
        </div>
        <section className="intro-rules" aria-label="대화 규칙">
          <p className="intro-rules-heading">
            {chosen?.name ?? "상대"}의 마음을 바꿀 기회는 단 <strong>5번!</strong>
          </p>
          <p className="intro-rules-lede">
            주어진 <strong>600자</strong> 안에서 {chosen?.name ?? "상대"}를 설득해 보세요.
          </p>
          <p className="intro-rules-note">
            보낸 메시지는 수정할 수 없고, {chosen?.name ?? "상대"}의 마음이 얼마나 움직였는지는 대화가 끝난 뒤 확인할 수 있어요.
          </p>
        </section>
        <label className="check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => (setConsent(e.target.checked), setError(""))}
          />
          <span>
            대화와 서비스 이용 기록은 이름 없이 저장되며, 윤재와 서아를 더
            자연스러운 캐릭터로 만드는 데 활용될 수 있어요.
          </span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" onClick={start} disabled={busy}>
          {busy ? "카페로 가는 중…" : "대화 시작하기"}
        </button>
      </div>
    </main>
  );
}

function KakaoCard({ game }: { game: StartResponse }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="kakao">
      <button
        className="kakao-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        오늘 주고받은 메시지 {open ? "접기" : "보기"}
      </button>
      {open && (
        <ol className="kakao-list">
          {game.scenario.kakao.map((k, i) => (
            <li key={i} className={`kakao-row ${k.from}`}>
              <div className="kakao-line">
                <span className="kakao-bubble">{k.text}</span>
                <time>{k.time}</time>
              </div>
              {k.readAt && <div className="kakao-read">읽음 {k.readAt}</div>}
            </li>
          ))}
          <li className="kakao-note">
            약 8시간 반 동안 답장 없음, 15:32에 한 번 읽음, 그 사이 보낸
            메시지 7개
          </li>
        </ol>
      )}
    </section>
  );
}

type Notice = {
  kind: "error" | "info";
  text: string;
  action?: "restart" | "finish";
};

function Chat({
  session,
  update,
  onRestart,
}: {
  session: SavedGame;
  update: (p: Partial<SavedGame>) => void;
  onRestart: () => void;
}) {
  const { game } = session;
  const { rules, scenario } = game;
  const [msgs, setMsgs] = useState<Msg[]>(session.msgs);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(true);
  const [typing, setTyping] = useState(false);
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmGiveup, setConfirmGiveup] = useState(false);
  const tokenRef = useRef(session.token);
  const pending = useRef<{ text: string; key: string } | null>(null);
  const idRef = useRef(session.msgs.reduce((m, x) => Math.max(m, x.id + 1), 0));
  const endRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  // 화면에 보이는 대화를 저장해 둔다 (새로고침 복구)
  useEffect(() => {
    update({ msgs });
  }, [msgs]);

  const push = (who: Msg["who"], beat: Beat): number => {
    const id = idRef.current++; // 업데이트 함수 밖에서 정해야 StrictMode 이중 실행에도 id가 그대로다
    setMsgs((m) => [...m, { id, who, beat }]);
    return id;
  };

  const playBeats = async (beats: Beat[], animate = true) => {
    for (const b of beats) {
      if (animate && !reduceMotion()) {
        setTyping(true);
        await wait(Math.min(1400, 450 + chars(b.content) * 18));
        setTyping(false);
      }
      push("npc", b);
      if (animate && !reduceMotion()) await wait(250);
    }
  };

  const applyProgress = (p: {
    token: string;
    turnsUsed: number;
    charsLeft: number;
    finished: boolean;
  }) => {
    tokenRef.current = p.token;
    update({
      token: p.token,
      turns: p.turnsUsed,
      left: p.charsLeft,
      finished: p.finished,
    });
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (session.msgs.length === 0)
      void playBeats(scenario.opening).then(() => setBusy(false));
    else if (session.finished) void goEnding(false);
    else setBusy(false);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: reduceMotion() ? "auto" : "smooth",
      block: "end",
    });
  }, [msgs, typing, closing]);

  const goEnding = async (giveup: boolean) => {
    setClosing(true);
    setNotice(null);
    await wait(reduceMotion() ? 0 : 1200);
    try {
      const res = await api.finish(tokenRef.current, giveup);
      tokenRef.current = res.token;
      update({
        token: res.token,
        finished: true,
        ending: { data: res.report, stats: res.stats },
      });
      tag("outcome", res.report.outcome);
      tag("shake", String(res.report.shake));
      track(giveup ? "game_given_up" : "ending_shown");
      window.scrollTo({ top: 0 });
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      setNotice({
        kind: "error",
        text: err?.message ?? "결과를 불러오지 못했어요. 다시 시도해 주세요.",
        action: err?.code === "session_expired" ? "restart" : "finish",
      });
    }
  };

  /** 서버 기록에 맞춰 대화를 이어 붙인다 (응답을 못 받았던 마디 포함). */
  const appendExchanges = async (
    exchanges: Exchange[],
    animateLast: boolean
  ) => {
    for (const [i, ex] of exchanges.entries()) {
      push("me", { type: "dialogue", content: ex.player });
      await playBeats(ex.beats, animateLast && i === exchanges.length - 1);
    }
  };

  const send = async () => {
    const msg = text.trim();
    if (!msg)
      return setNotice({ kind: "error", text: "할 말을 입력해 주세요." });
    if (chars(msg) > rules.messageMax)
      return setNotice({
        kind: "error",
        text: `한 번에 ${rules.messageMax}자까지 말할 수 있어요.`,
      });
    if (chars(msg) > session.left)
      return setNotice({
        kind: "error",
        text: `발언권이 ${session.left}자 남았어요.`,
      });
    // 같은 말을 다시 보내면 같은 키 (서버가 처음 결과를 돌려준다). 말을 바꾸면 새 키.
    const key = pending.current?.text === msg ? pending.current.key : newKey();
    pending.current = { text: msg, key };
    setBusy(true);
    setNotice(null);
    const optimisticId = push("me", { type: "dialogue", content: msg });
    setText("");
    setTyping(true);
    let finished = false;
    try {
      const res = await api.turn(tokenRef.current, msg, key);
      pending.current = null;
      setTyping(false);
      setMsgs((m) => m.filter((x) => x.id !== optimisticId));
      applyProgress(res);
      track("turn_sent");
      await appendExchanges(res.exchanges, true);
      finished = res.finished;
    } catch (e) {
      setTyping(false);
      setMsgs((m) => m.filter((x) => x.id !== optimisticId));
      const err =
        e instanceof ApiError
          ? e
          : new ApiError("unknown", "문제가 생겼어요. 다시 보내 주세요.", true);
      if (err.resync) {
        // 이미 기록된 마디가 있었다: 기록을 보여 주고, 방금 쓴 말은 입력창에 돌려준다.
        pending.current = null;
        applyProgress(err.resync);
        await appendExchanges(err.resync.exchanges, false);
        finished = err.resync.finished;
        if (!finished && err.resync.exchanges.at(-1)?.player !== msg)
          setText(msg);
        if (err.resync.exchanges.length > 0)
          setNotice({ kind: "info", text: err.message });
      } else {
        setText(msg);
        track(`error_${err.code}`);
        setNotice({
          kind: "error",
          text: err.message,
          ...(err.code === "session_expired"
            ? { action: "restart" as const }
            : {}),
        });
      }
    }
    if (finished) {
      await wait(reduceMotion() ? 0 : 900);
      await goEnding(false);
    } else setBusy(false);
  };

  const msgLen = chars(text);
  const over = msgLen > rules.messageMax || msgLen > session.left;
  const pct = Math.max(0, (session.left / rules.charBudget) * 100);

  const noticeView = notice && (
    <div
      className={notice.kind === "error" ? "notice error" : "notice info"}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      <p>{notice.text}</p>
      {notice.action === "restart" && (
        <button className="primary small" onClick={onRestart}>
          처음부터 다시 하기
        </button>
      )}
      {notice.action === "finish" && (
        <button
          className="primary small"
          onClick={() => void goEnding(!session.finished)}
        >
          결과 다시 불러오기
        </button>
      )}
    </div>
  );

  return (
    <main className="chat">
      <header className="chat-head">
        <div>
          <h1 className="chat-name">
            {scenario.partnerLabel ?? "연인"} {scenario.npcName}
          </h1>
          <p className="chat-place">사귄 지 1년 넘음, {scenario.place}</p>
          <p className="chat-place">
            오늘 낮, 답장이 없었던 일을 두고 마주 앉아 있어요.
          </p>
        </div>
        <div className="chat-meter">
          <span className="chat-turn">
            {Math.min(session.turns + 1, rules.maxTurns)}/{rules.maxTurns}번째
            말
          </span>
          <div
            className="budget"
            role="meter"
            aria-label="남은 발언권"
            aria-valuemin={0}
            aria-valuemax={rules.charBudget}
            aria-valuenow={session.left}
          >
            <div className="budget-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="chat-left">발언권 {session.left}자</span>
        </div>
      </header>

      <KakaoCard game={game} />

      <ol className="thread" aria-live="polite" data-clarity-unmask="true">
        {msgs.map((m) =>
          m.beat.type === "narration" ? (
            <li key={m.id} className="beat-narr">
              {m.beat.content}
            </li>
          ) : (
            <li key={m.id} className={`bubble ${m.who}`}>
              {m.beat.content}
            </li>
          )
        )}
        {typing && (
          <li
            className="typing"
            aria-label={`${scenario.npcName}가 말을 고르는 중`}
          >
            <span />
            <span />
            <span />
          </li>
        )}
        {closing && <li className="closing">대화가 끝났어요</li>}
        {closing && !notice && (
          <li className="loading" role="status">
            <span className="spinner" aria-hidden="true" />
            {scenario.npcName}의 속마음을 정리하는 중…
          </li>
        )}
      </ol>
      <div ref={endRef} className="thread-end" />

      {closing ? (
        notice && <div className="composer">{noticeView}</div>
      ) : (
        <div className="composer">
          {noticeView}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (notice?.kind === "error" && notice.action !== "restart")
                setNotice(null);
            }}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!busy) void send();
              }
            }}
            placeholder={busy ? "" : `${scenario.npcName}에게 하고 싶은 말`}
            rows={3}
            disabled={busy || notice?.action === "restart"}
            aria-label={`${scenario.npcName}에게 할 말`}
            aria-invalid={over}
          />
          <div className="composer-bar">
            <span className={`count ${over ? "over" : ""}`}>
              {msgLen}/{Math.min(rules.messageMax, session.left)}자
            </span>
            <button
              className="chip chip-quiet"
              onClick={() => setConfirmGiveup(true)}
              disabled={busy}
            >
              포기하기
            </button>
            <button
              className="primary small"
              onClick={() => void send()}
              disabled={busy || over || notice?.action === "restart"}
            >
              {pending.current && pending.current.text === text.trim()
                ? "다시 보내기"
                : "말하기"}
            </button>
          </div>
        </div>
      )}
      <GiveupDialog
        open={confirmGiveup}
        npcName={scenario.npcName}
        turnsUsed={session.turns}
        onKeep={() => setConfirmGiveup(false)}
        onStop={() => {
          setConfirmGiveup(false);
          void goEnding(true);
        }}
      />
    </main>
  );
}
