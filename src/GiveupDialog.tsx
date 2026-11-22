// 포기 확인 모달. 되돌릴 수 없는 선택이라 화면을 멈추고 한 번 더 묻는다.
// 브라우저 기본 <dialog>를 써서 포커스 가두기, Esc 닫기, 배경 막기를 그대로 얻는다.
// 모바일에서는 아래에서 올라오는 시트, 넓은 화면에서는 가운데 카드 (styles.css .giveup-dialog).
import { useEffect, useRef } from "react";

export function GiveupDialog({
  open,
  npcName,
  turnsUsed,
  onKeep,
  onStop,
}: {
  open: boolean;
  /** 연인 이름. 모두 받침이 없어 조사가 같다 (server/content.ts PARTNERS) */
  npcName: string;
  /** 지금까지 보낸 마디 수 */
  turnsUsed: number;
  onKeep: () => void;
  onStop: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // 실수로 포기하지 않게 안전한 쪽에 포커스
      keepRef.current?.focus();
    } else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="giveup-dialog"
      aria-labelledby="giveup-title"
      aria-describedby="giveup-desc"
      // Esc
      onCancel={(e) => {
        e.preventDefault();
        onKeep();
      }}
      // 바깥(배경) 누르기: 클릭 대상이 dialog 자체면 카드 밖이다
      onClick={(e) => {
        if (e.target === e.currentTarget) onKeep();
      }}
    >
      <div className="giveup-sheet">
        <h2 id="giveup-title" className="giveup-title">
          정말 이대로 대화를 끝낼까요?
        </h2>
        <div id="giveup-desc" className="giveup-desc">
          <p>{turnsUsed > 0 ? `아직 ${npcName}에게 진심을 다 전하지 못했어요.` : `아직 ${npcName}에게 진심을 전하지 않았어요.`}</p>
          <p>서운한 마음도, 풀지 못한 오해도 대화를 나누다 보면 달라질 수 있지 않을까요?</p>
          <p>{npcName}는 아직 당신의 이야기를 들을 준비가 되어 있어요.</p>
        </div>
        <div className="giveup-actions">
          <button ref={keepRef} className="giveup-keep" onClick={onKeep}>
            계속하기
          </button>
          <button className="giveup-stop" onClick={onStop}>
            그만하기
          </button>
        </div>
      </div>
    </dialog>
  );
}
