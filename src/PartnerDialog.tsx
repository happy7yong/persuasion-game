import { useEffect, useRef, useState } from "react";
import { PARTNER_OPTIONS, type Partner } from "./api";

export function PartnerDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (partner: Partner) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Partner | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSelected(null);
      dialog.showModal();
    }
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="giveup-dialog partner-dialog"
      aria-labelledby="partner-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="giveup-sheet partner-sheet">
        <h2 id="partner-dialog-title" className="giveup-title">
          누구와 이야기할까요?
        </h2>
        <p className="partner-dialog-desc">오늘의 이야기를 들려줄 연인을 골라 주세요.</p>
        <div className="partner-dialog-options">
          {PARTNER_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={selected === option.key ? "on" : ""}
              aria-pressed={selected === option.key}
              onClick={() => setSelected(option.key)}
            >
              <span>{option.label}</span>
              <strong>{option.name}</strong>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="primary"
          disabled={!selected}
          onClick={() => selected && onSelect(selected)}
        >
          선택하기
        </button>
      </div>
    </dialog>
  );
}
