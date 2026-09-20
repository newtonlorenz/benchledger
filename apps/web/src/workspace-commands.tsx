import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "./components/ui/command";
import { Button } from "./components/ui/button";
import { useState } from "react";
import { Icon } from "./icons";
import type { IconName } from "./icons";
export interface WorkspaceCommand { id: string; label: string; detail: string; group: "Navigation" | "Actions" | "Projects" | "Loaded inventory"; icon: IconName; run(): void }
export function filterWorkspaceCommands(commands: readonly WorkspaceCommand[], query: string): WorkspaceCommand[] {
  const terms = query.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim().split(/\s+/u).filter(Boolean);
  return commands.filter((command) => { const text = `${command.label} ${command.detail}`.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase(); return terms.every((term) => text.includes(term)); }).slice(0, 12);
}
export function WorkspaceCommands({ commands, onRun, onSearchInventory }: { commands: WorkspaceCommand[]; onRun(command: WorkspaceCommand): void; onSearchInventory(): void }) {
 const [query,setQuery] = useState(""); const results = filterWorkspaceCommands(commands,query);
 return <Command className="workspace-commands" shouldFilter={false} loop><CommandInput autoFocus data-autofocus aria-label="Find a page, project or action" placeholder="Find a page, project or action" value={query} onValueChange={setQuery}/><CommandList aria-label="Workspace commands">{results.map(command => <CommandItem key={command.id} value={command.id} onSelect={() => onRun(command)} className="command-result"><Icon name={command.icon} size={18}/><span><strong>{command.label}</strong><small>{command.detail}</small></span><span className="command-group">{command.group}</span></CommandItem>)}<CommandEmpty>No matching command. <Button variant="outline" onClick={onSearchInventory}>Search inventory</Button></CommandEmpty></CommandList><div className="command-footer"><span>↑ ↓ Select · ↵ Open</span><span>Project and item results use loaded records.</span></div></Command>;
}
