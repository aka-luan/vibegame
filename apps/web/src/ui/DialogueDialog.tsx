import { useEffect, useRef } from "react";

import type { DialogueNodeMessage, ErrorCode } from "@gameish/protocol";

export function DialogueDialog({
  node,
  error,
  textScale,
  onTextScaleChange,
  onChoice,
  onClose,
}: {
  node: DialogueNodeMessage;
  error: ErrorCode | undefined;
  textScale: number;
  onTextScaleChange: (scale: number) => void;
  onChoice: (choiceId: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    const firstFocusable = dialog.querySelector<HTMLElement>(
      "[data-dialogue-focus]",
    );
    (firstFocusable ?? dialog).focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled)",
        ),
      ];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", handleKeyDown);
    return () => {
      dialog.removeEventListener("keydown", handleKeyDown);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="dialogue-dialog"
      aria-labelledby="dialogue-speaker"
      aria-describedby="dialogue-text"
      aria-modal="true"
      tabIndex={-1}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      style={{ "--dialogue-scale": textScale } as React.CSSProperties}
    >
      <div className="dialogue-heading">
        <p id="dialogue-speaker" className="dialogue-speaker">
          {node.speaker}
        </p>
        <button type="button" onClick={onClose} data-dialogue-focus>
          Close
        </button>
      </div>
      <p id="dialogue-text" className="dialogue-text">
        {node.text}
      </p>
      {error ? (
        <p className="dialogue-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialogue-choices" aria-label="Dialogue choices">
        {node.choices.map((choice, index) => (
          <button
            type="button"
            key={choice.id}
            data-dialogue-focus={index === 0 ? true : undefined}
            onClick={() => onChoice(choice.id)}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <label className="dialogue-scale-control">
        Text size
        <input
          aria-label="Dialogue text scale"
          type="range"
          min="1"
          max="1.75"
          step="0.05"
          value={textScale}
          onChange={(event) =>
            onTextScaleChange(Number(event.currentTarget.value))
          }
        />
      </label>
    </dialog>
  );
}
