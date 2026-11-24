import type { Kakao } from "./api";

type Props = {
  kakao: Kakao[];
  npcName: string;
};

function ProfilePhoto({ name }: { name: string }) {
  return (
    <span
      className={`kakao-avatar ${name === "서아" ? "seoa" : "yunjae"}`}
      role="img"
      aria-label={`${name}의 프로필 사진`}
    />
  );
}

export function KakaoPhone({ kakao, npcName }: Props) {
  return (
    <section className="kakao" aria-label={`${npcName}와 오늘 주고받은 메시지`}>
      <div className="kakao-phone-top" aria-hidden="true">
        <span className="kakao-phone-speaker" />
      </div>
      <div className="kakao-header">
        <ProfilePhoto name={npcName} />
        <div className="kakao-header-person">
          <strong>{npcName}</strong>
        </div>
      </div>
      <div className="kakao-screen">
        <ol className="kakao-list">
          {kakao.map((message, index) => (
            <li
              key={`${message.time}-${index}`}
              className={`kakao-row ${message.from}`}
            >
              {message.from === "npc" && <ProfilePhoto name={npcName} />}
              <div className="kakao-message">
                {message.from === "npc" && (
                  <span className="kakao-sender">{npcName}</span>
                )}
                <div className="kakao-line">
                  <span className="kakao-bubble">{message.text}</span>
                  <time>{message.time}</time>
                </div>
                {message.readAt && (
                  <span className="kakao-read">읽음 {message.readAt}</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
