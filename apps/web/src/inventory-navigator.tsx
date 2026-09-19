import { useState } from "react";
import { categoryTree } from "./category-ui";
import type { ManagedInventoryCategory } from "./category-ui";
import { matchesInventorySearch } from "@benchledger/domain/inventory-search";
import { Icon } from "./icons";

export function InventoryNavigator({ categories, selectedId, loading, error, onSelect, onManage }: {
  categories: readonly ManagedInventoryCategory[];
  selectedId: string;
  loading: boolean;
  error: string | undefined;
  onSelect(id: string): void;
  onManage(): void;
}) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const tree = categoryTree(categories);
  const nodes = tree.filter(({ category, children }) => matchesInventorySearch([category.name, ...children.map((child) => child.name)], query));
  const categoryButton = (category: ManagedInventoryCategory, label = category.name) => <button type="button" className={`inventory-category-link ${selectedId === category.id ? "is-selected" : ""}`} aria-current={selectedId === category.id ? "page" : undefined} aria-label={`Filter inventory category ${label}`} title={label} onClick={() => onSelect(category.id)}><Icon name="folder" size={15} /><span>{category.name}</span></button>;
  return <section className="inventory-navigator" aria-label="Inventory navigator">
    <div className="navigator-heading"><strong>Categories</strong><button type="button" className="icon-button" aria-label="Manage inventory categories" title="Manage categories" onClick={onManage}><Icon name="settings" size={14} /></button></div>
    <label className="navigator-search"><Icon name="search" size={14} /><input aria-label="Find an inventory category" placeholder="Find a category…" maxLength={120} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    <nav aria-label="Inventory categories" className="inventory-category-list">
      <button type="button" className={`inventory-category-link ${selectedId === "" ? "is-selected" : ""}`} aria-current={selectedId === "" ? "page" : undefined} onClick={() => onSelect("")}><Icon name="box" size={15} /><span>All categories</span></button>
      <button type="button" className={`inventory-category-link ${selectedId === "__unassigned__" ? "is-selected" : ""}`} aria-current={selectedId === "__unassigned__" ? "page" : undefined} onClick={() => onSelect("__unassigned__")}><Icon name="tag" size={15} /><span>Unassigned items</span></button>
      <ul>{nodes.map(({ category, children }) => {
        const expanded = Boolean(query.trim()) || !collapsed.has(category.id);
        const shownChildren = matchesInventorySearch([category.name], query) ? children : children.filter((child) => matchesInventorySearch([category.name, child.name], query));
        return <li key={category.id}><div className="inventory-category-parent">{categoryButton(category)}{children.length > 0 && !query.trim() && <button type="button" className="inventory-category-disclosure" aria-label={`${expanded ? "Collapse" : "Expand"} ${category.name} subcategories`} aria-expanded={expanded} onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(category.id)) next.delete(category.id); else next.add(category.id); return next; })}><Icon name={expanded ? "chevron-down" : "chevron-right"} size={14} /></button>}</div>
          {expanded && shownChildren.length > 0 && <ul>{shownChildren.map((child) => <li key={child.id}>{categoryButton(child, `${category.name} / ${child.name}`)}</li>)}</ul>}
        </li>;
      })}</ul>
      {loading ? <p className="navigator-empty" role="status">Loading categories…</p> : error ? <p className="navigator-empty" role="status">Categories unavailable. Search all inventory or retry in Settings.</p> : !nodes.length && <p className="navigator-empty">{query.trim() ? "No matching categories." : "Add categories in Settings to organise inventory."}</p>}
    </nav>
    {query && <button type="button" className="text-button navigator-clear" onClick={() => setQuery("")}>Clear category search</button>}
    <p className="inventory-navigator-note">Each category shows its own assigned items.</p>
  </section>;
}
