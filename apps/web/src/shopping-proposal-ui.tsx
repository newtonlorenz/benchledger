import { useEffect, useRef, useState } from "react";
import type { Project } from "./domain";
import { loadShoppingProposal, shoppingProposalText } from "./shopping-proposal";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { Disclosure, DisclosureTrigger, DisclosureContent } from "./components/ui/disclosure";

export interface ShoppingProposalProps {
  project: Project;
  root: string;
  disabled?: boolean;
  /** Change when canonical sourcing refreshes, including selected quote changes. */
  sourceVersion?: unknown;
}
export function ShoppingProposal({ project, root, disabled = false, sourceVersion }: ShoppingProposalProps) {
  const identity = JSON.stringify([root, project.id, project.serverRevisionId, project.name, project.currentRevision, project.bom.map(line => [line.id,line.version]), sourceVersion]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const pending = useRef<AbortController | undefined>(undefined);
  const [busy,setBusy] = useState(false), [error,setError] = useState<string>(), [notice,setNotice] = useState<string>();
  const [prepared,setPrepared] = useState<{ identity: string; text: string }>();
  const [showText,setShowText] = useState(false), [manualCopy,setManualCopy] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    pending.current?.abort(); pending.current = undefined;
    setBusy(false); setPrepared(undefined); setError(undefined); setNotice(undefined); setShowText(false); setManualCopy(false);
    return () => { pending.current?.abort(); pending.current = undefined; };
  }, [identity, disabled]);
  useEffect(() => { if (manualCopy && showText) { textArea.current?.focus(); textArea.current?.select(); } }, [manualCopy,showText]);
  const current = !disabled && prepared?.identity === identity ? prepared : undefined;
  const prepare = async (action: "copy" | "download") => {
    if (disabled || pending.current || !project.serverRevisionId) return;
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError(undefined); setNotice(undefined); setPrepared(undefined); setManualCopy(false); setShowText(false);
    const active = () => !controller.signal.aborted && identityRef.current === identity;
    try {
      const snapshot = await loadShoppingProposal({ projectId: project.id, revisionId: project.serverRevisionId, root, signal: controller.signal });
      if (!active()) return;
      const text = shoppingProposalText(snapshot, { name: project.name, revision: `${project.currentRevision} (${project.serverRevisionId})` });
      setPrepared({ identity, text });
      if (action === "copy") {
        try {
          if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
          await navigator.clipboard.writeText(text);
          if (active()) setNotice(`Proposal copied. Snapshot prepared ${new Date(snapshot.preparedAt).toLocaleString("en-GB")}.`);
        } catch {
          if (active()) { setManualCopy(true); setShowText(true); setNotice("Clipboard access was unavailable. Select and copy the proposal below, or download it as text."); }
        }
      } else {
        const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url;
        link.download = `shopping-proposal-${snapshot.preparedAt.slice(0,10)}.txt`;
        document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        setNotice(`Proposal text prepared for download. Snapshot prepared ${new Date(snapshot.preparedAt).toLocaleString("en-GB")}.`);
      }
    } catch (failure) {
      if (active()) { setPrepared(undefined); setError(failure instanceof Error ? failure.message : "The complete proposal could not be loaded. Try again; no partial proposal was prepared."); }
    } finally {
      if (pending.current === controller) { pending.current = undefined; setBusy(false); }
    }
  };
  return <div className="shopping-proposal" aria-label="Shopping proposal export">
    <p className="form-hint">Copy or download a dated proposal for every requirement in this revision, including selected quotes and unresolved gaps. It is a proposal, never an order.</p>
    <div className="dialog-actions"><Button variant="outline" type="button" disabled={disabled || busy || !project.serverRevisionId} onClick={() => { void prepare("copy"); }}>Copy proposal</Button><Button variant="ghost" type="button" disabled={disabled || busy || !project.serverRevisionId} onClick={() => { void prepare("download"); }}>Download proposal text</Button></div>
    {busy && <p role="status">Checking the complete revision and selected quotes…</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {notice && current && <p role="status">{notice}</p>}
    {current && <Disclosure open={showText} onOpenChange={setShowText}><DisclosureTrigger>Review proposal text</DisclosureTrigger><DisclosureContent><Textarea ref={textArea} aria-label="Shopping proposal text" readOnly value={current.text} rows={12} onFocus={event => { if (manualCopy) event.currentTarget.select(); }}/></DisclosureContent></Disclosure>}
  </div>;
}
