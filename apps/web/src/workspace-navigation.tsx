import type { RefObject } from "react";
import { Button } from "./components/ui/button";
import { Icon } from "./icons";

type WorkspacePage = "overview" | "inventory" | "projects" | "settings" | "capabilities";
type NavigationProps = { page: WorkspacePage; onNavigate(page: WorkspacePage): void };

export function WorkspaceNavigation({ page, onNavigate, onCommands, searchRef }: NavigationProps & {
  onCommands(): void; searchRef: RefObject<HTMLButtonElement | null>;
}) {
  const projectsActive = page === "overview" || page === "projects";
  return <header className="topbar workspace-header">
    <Button variant="ghost" className="workspace-brand" aria-label="BenchLedger projects" onClick={() => onNavigate("overview")}>
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span><span>BenchLedger</span>
    </Button>
    <nav className="workspace-primary-navigation" aria-label="Workspace">
      <Button variant="ghost" aria-current={projectsActive ? "page" : undefined} onClick={() => onNavigate("overview")}>Projects</Button>
      <Button variant="ghost" aria-current={page === "inventory" ? "page" : undefined} onClick={() => onNavigate("inventory")}>Inventory</Button>
    </nav>
    <div className="topbar-actions">
      <Button ref={searchRef} variant="ghost" size="icon" className="icon-button command-launcher" aria-label="Open workspace commands" title="Search and commands (Control or Command + Shift + K)" onClick={onCommands}><Icon name="search" size={20} /></Button>
      <Button variant="ghost" size="icon" className="icon-button" aria-label="Open workspace settings" aria-current={page === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><Icon name="settings" size={20} /></Button>
    </div>
  </header>;
}

export function WorkspaceBottomNavigation({ page, onNavigate }: NavigationProps) {
  return <nav className="workspace-bottom-navigation" aria-label="Workspace on phone">
    <Button variant="ghost" aria-current={page === "overview" || page === "projects" ? "page" : undefined} onClick={() => onNavigate("overview")}><Icon name="folder" size={22} /><span>Projects</span></Button>
    <Button variant="ghost" aria-current={page === "inventory" ? "page" : undefined} onClick={() => onNavigate("inventory")}><Icon name="box" size={22} /><span>Inventory</span></Button>
  </nav>;
}
