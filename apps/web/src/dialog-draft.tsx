import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Lets a form inside a dialog say "I have typed input". The dialog then
 * ignores scrim clicks and asks before Escape/close discards the draft.
 */
export const DialogDraftContext = createContext<((dirty: boolean) => void) | null>(null);

export function useDialogDraft(dirty: boolean): void {
  const report = useContext(DialogDraftContext);
  useEffect(() => {
    report?.(dirty);
    return () => report?.(false);
  }, [report, dirty]);
}

export function useDraftAwareClose(onClose: () => void, externalDirty = false) {
  const [reportedDirty, setDirtyState] = useState(false);
  const dirty = externalDirty || reportedDirty;
  const [confirming, setConfirming] = useState(false);
  const setDirty = useCallback((value: boolean) => setDirtyState(value), []);
  return {
    dirty,
    setDirty,
    confirming,
    /** Escape and the close button: ask first when there is a draft. */
    requestClose: () => { if (confirming) setConfirming(false); else if (dirty) setConfirming(true); else onClose(); },
    /** Scrim clicks never discard a draft. */
    scrimClose: () => { if (!dirty) onClose(); },
    keep: () => setConfirming(false),
    discard: () => { setConfirming(false); onClose(); }
  };
}

export function DiscardDraftPrompt({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className="dialog-discard-prompt" role="alert">
      <p><strong>Discard what you typed?</strong> Your changes in this form have not been saved.</p>
      <div className="dialog-actions">
        <button type="button" className="button button-primary" autoFocus onClick={onKeep}>Keep editing</button>
        <button type="button" className="button button-danger" onClick={onDiscard}>Discard</button>
      </div>
    </div>
  );
}
