import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
export interface WorkspaceCommand { id: string; label: string; detail: string; group: "Navigation" | "Actions" | "Projects" | "Inventory"; icon: IconName; run(): void }
export function filterWorkspaceCommands(commands: readonly WorkspaceCommand[], query: string): WorkspaceCommand[] {
  const terms = query.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim().split(/\s+/u).filter(Boolean);
  return commands.filter((command) => { const text = `${command.label} ${command.detail}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(); return terms.every((term) => text.includes(term)); }).slice(0, 12);
}
const SERVER_SEARCH_DELAY_MS = 200;
/**
 * `onSearchItems` searches the whole inventory on the server (not only the
 * rows already loaded in the browser) and returns commands that open items.
 */
export function WorkspaceCommands({ commands, onRun, onSearchInventory, onSearchItems }: { commands: WorkspaceCommand[]; onRun(command: WorkspaceCommand): void; onSearchInventory(): void; onSearchItems?: ((query: string, signal: AbortSignal) => Promise<WorkspaceCommand[]>) | undefined }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [itemResults, setItemResults] = useState<{ query: string; commands: WorkspaceCommand[] }>();
  const [searching, setSearching] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    const trimmed = query.trim();
    if (!onSearchItems || trimmed.length < 2) { setItemResults(undefined); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timeout = window.setTimeout(() => {
      onSearchItems(trimmed, controller.signal).then((found) => {
        if (!controller.signal.aborted) setItemResults({ query: trimmed, commands: found });
      }).catch(() => {
        if (!controller.signal.aborted) setItemResults({ query: trimmed, commands: [] });
      }).finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, SERVER_SEARCH_DELAY_MS);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [query, onSearchItems]);
  const results = [...filterWorkspaceCommands(commands, query), ...(itemResults && itemResults.query === query.trim() ? itemResults.commands.slice(0, 8) : [])];
  const selected = Math.min(active, Math.max(0, results.length - 1));
  useEffect(() => { root.current?.querySelector(`[data-result-index="${selected}"]`)?.scrollIntoView({ block: "nearest" }); }, [selected, query]);
  const choose = (index: number) => { const command = results[index]; if (command) onRun(command); };
  return <div className="workspace-commands" ref={root}>
    <label className="command-search"><Icon name="search" size={19} /><input autoFocus data-autofocus role="combobox" aria-label="Find a page, project or action" aria-expanded="true" aria-autocomplete="list" aria-controls={listId} aria-activedescendant={results.length ? `${listId}-${selected}` : undefined} placeholder="Find a page, project or action" value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => { if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const count = results.length; setActive(count ? event.key === "Home" ? 0 : event.key === "End" ? count - 1 : (selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count : 0); } else if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); choose(selected); } }} /><kbd>ESC</kbd></label>
    <div className="command-results" id={listId} role="listbox" aria-label="Workspace commands">
      {results.map((command, index) => <div role="option" id={`${listId}-${index}`} aria-selected={index === selected} key={command.id} data-result-index={index} className={`command-result ${index === selected ? "is-active" : ""}`} onPointerMove={() => setActive(index)} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}><span className="command-result-icon"><Icon name={command.icon} size={18} /></span><span><strong>{command.label}</strong><small>{command.detail}</small></span><span className="command-group">{command.group}</span><Icon name="arrow-right" size={15} /></div>)}
    </div>
    {searching && <p className="command-searching" role="status">Searching inventory…</p>}
    {!results.length && !searching && <div className="command-empty"><strong>No matching command</strong><p>Use inventory search to search all stock records.</p><button className="button button-secondary" type="button" onClick={onSearchInventory}>Search inventory</button></div>}
    <div className="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> Select <kbd>↵</kbd> Open</span><span>{onSearchItems ? "Inventory results search all stock records." : "Project and item results use loaded records."}</span></div>
  </div>;
}
