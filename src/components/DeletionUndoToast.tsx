interface DeletionUndoToastProps {
  label: string;
  onUndo: () => void;
}

/** Displays a short-lived, navigation-pinning recovery action after a local item is deleted. */
export function DeletionUndoToast({ label, onUndo }: DeletionUndoToastProps) {
  return (
    <div
      data-pin-terminal-navigation="true"
      role="status"
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] left-1/2 z-40 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 items-center justify-between gap-4 border border-[#2fbffc] bg-[#02080d] px-4 py-3 text-[#5cd0ff] shadow-[0_0_24px_#2fbffc44] phoneLandscape:bottom-3"
    >
      <span className="min-w-0 truncate text-xs">{label}</span>
      <button type="button" className="shrink-0 border border-[#2fbffc] px-3 py-2 text-xs font-bold hover:bg-[#072233]" onClick={onUndo}>되돌리기</button>
    </div>
  );
}
