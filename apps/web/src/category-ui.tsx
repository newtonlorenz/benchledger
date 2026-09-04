import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "./icons";

/** Web-facing projection of the additive managed taxonomy contract. */
export interface ManagedInventoryCategory {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string;
  readonly sortOrder: number;
  readonly archived: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The same deterministic starter labels seeded by the server foundation. */
export const DEFAULT_MANAGED_INVENTORY_CATEGORIES: readonly ManagedInventoryCategory[] = [
  "printers", "printer-accessories", "printer-parts", "filament", "tools", "workshop", "fasteners", "adhesives", "finishes", "lighting", "electronics", "electrical", "consumables", "other"
].map((slug, sortOrder) => ({
  id: `category-${slug}`,
  name: slug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
  sortOrder,
  archived: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1
}));

export interface CategoryCreateInput {
  readonly id?: string;
  readonly name: string;
  readonly parentId?: string;
  readonly sortOrder?: number;
}

export interface CategoryUpdateInput {
  readonly name?: string;
  readonly sortOrder?: number;
}

export interface CategoryTreeNode {
  readonly category: ManagedInventoryCategory;
  readonly children: readonly ManagedInventoryCategory[];
}

export function categoryTree(categories: readonly ManagedInventoryCategory[]): readonly CategoryTreeNode[] {
  const active = categories.filter((category) => !category.archived);
  const parents = active.filter((category) => category.parentId === undefined)
    .sort(categoryOrder);
  return parents.map((category) => ({
    category,
    children: active.filter((child) => child.parentId === category.id).sort(categoryOrder)
  }));
}

function categoryOrder(left: ManagedInventoryCategory, right: ManagedInventoryCategory): number {
  return left.sortOrder - right.sortOrder || left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function categoryDisplayLabel(category: ManagedInventoryCategory, parent?: ManagedInventoryCategory): string {
  return parent ? `${parent.name} / ${category.name}` : category.name;
}

export interface InventoryCategoryFilterOption {
  readonly value: string;
  readonly label: string;
}

/** Build the category filter from the same active tree shown by the selectors. */
export function inventoryCategoryFilterOptions(categories: readonly ManagedInventoryCategory[]): readonly InventoryCategoryFilterOption[] {
  return categoryTree(categories).flatMap(({ category, children }) => [
    { value: category.id, label: category.name },
    ...children.map((child) => ({ value: child.id, label: categoryDisplayLabel(child, category) }))
  ]);
}

interface CategoryManagerProps {
  readonly categories: readonly ManagedInventoryCategory[];
  readonly onCreate: (input: CategoryCreateInput) => Promise<ManagedInventoryCategory | undefined>;
  readonly onUpdate: (id: string, input: CategoryUpdateInput, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>;
  readonly onArchive: (id: string, expectedVersion: number) => Promise<ManagedInventoryCategory | undefined>;
  /** Render without a second surface when the manager is embedded in Settings. */
  readonly embedded?: boolean;
}

interface CategoryFormProps {
  readonly title: string;
  readonly initialName?: string;
  readonly initialSortOrder?: number;
  readonly submitLabel: string;
  readonly onSubmit: (name: string, sortOrder: number) => Promise<boolean>;
  readonly onCancel: () => void;
}

function CategoryForm({ title, initialName = "", initialSortOrder = 0, submitLabel, onSubmit, onCancel }: CategoryFormProps) {
  const inputId = useId();
  const [name, setName] = useState(initialName);
  const [sortOrder, setSortOrder] = useState(String(initialSortOrder));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !name.trim()) return;
    const parsedOrder = Number(sortOrder);
    if (!Number.isSafeInteger(parsedOrder) || parsedOrder < 0) {
      setError("Order must be a whole number of zero or greater.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const saved = await onSubmit(name.trim(), parsedOrder);
      if (!saved) setError("The category was not saved. Check the service connection and try again.");
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "The category was not saved. Nothing changed.");
    } finally {
      setSaving(false);
    }
  };

  return <form className="category-inline-form" onSubmit={(event) => { void submit(event); }} aria-label={title}>
    <label className="form-field"><span>Name</span><input ref={inputRef} id={inputId} required value={name} onChange={(event) => setName(event.target.value)} disabled={saving} /></label>
    <label className="form-field category-order-field"><span>Order</span><input type="number" min="0" step="1" required value={sortOrder} onChange={(event) => setSortOrder(event.target.value)} disabled={saving} /></label>
    {error && <p className="form-error category-form-error" role="alert">{error}</p>}
    <div className="category-form-actions"><button type="button" className="button button-quiet" onClick={onCancel} disabled={saving}>Cancel</button><button type="submit" className="button button-primary" disabled={!name.trim() || saving}>{saving ? "Saving…" : submitLabel}<Icon name="check" size={15} /></button></div>
  </form>;
}

function CategoryAction({ label, icon, disabled = false, onClick }: { label: string; icon: Parameters<typeof Icon>[0]["name"]; disabled?: boolean; onClick: (target: HTMLButtonElement) => void }) {
  return <button type="button" className="icon-button category-action" aria-label={label} title={label} disabled={disabled} onClick={(event) => onClick(event.currentTarget)}><Icon name={icon} size={15} /></button>;
}

function ArchiveConfirmation({ category, onCancel, onConfirm, busy = false }: { category: ManagedInventoryCategory; onCancel: () => void; onConfirm: () => void; busy?: boolean }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);
  return <>
    <div className="category-archive-scrim" aria-hidden="true" onPointerDown={(event) => event.preventDefault()} />
    <div ref={confirmationRef} className="category-archive-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`archive-title-${category.id}`} tabIndex={-1} onKeyDown={(event) => {
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not([disabled])")];
    if (!focusable.length) {
      event.preventDefault();
      event.currentTarget.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && event.target === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && event.target === last) {
      event.preventDefault();
      first?.focus();
    }
    }}>
      <div><strong id={`archive-title-${category.id}`}>Archive {category.name}?</strong><span>It will disappear from new inventory selections. Existing records are not changed.</span></div>
      <div className="category-confirm-actions"><button ref={cancelRef} type="button" className="button button-quiet" onClick={onCancel} disabled={busy}>Cancel</button><button type="button" className="button button-secondary" onClick={onConfirm} disabled={busy}>{busy ? "Archiving…" : "Archive"}</button></div>
    </div>
  </>;
}

function CategoryRow({ category, parent, onEdit, onAddChild, onArchive, disabled = false }: {
  readonly category: ManagedInventoryCategory;
  readonly parent?: ManagedInventoryCategory;
  readonly onEdit: () => void;
  readonly onAddChild?: () => void;
  readonly onArchive: (target: HTMLButtonElement) => void;
  readonly disabled?: boolean;
}) {
  return <div className={`category-row ${parent ? "category-row-child" : ""}`}>
    <div className="category-row-name"><span className="category-row-icon" aria-hidden="true"><Icon name={parent ? "arrow-right" : "layers"} size={15} /></span><div><strong>{parent ? categoryDisplayLabel(category, parent) : category.name}</strong><small>{parent ? "Subcategory" : "Top-level category"} · Order {category.sortOrder}</small></div></div>
    <div className="category-row-actions">
      <button type="button" className="text-button category-edit-button" aria-label={`Rename ${category.name}`} onClick={onEdit} disabled={disabled}>Rename / edit order</button>
      {onAddChild && <button type="button" className="text-button category-add-child-button" onClick={onAddChild} disabled={disabled}>Add subcategory</button>}
      <CategoryAction label={`Archive ${category.name}`} icon="archive" onClick={onArchive} disabled={disabled} />
    </div>
  </div>;
}

/**
 * Settings manager for the user taxonomy. Parentage is deliberately absent
 * from edit controls: the API treats it as immutable after creation.
 */
export function CategoryManager({ categories, onCreate, onUpdate, onArchive, embedded = false }: CategoryManagerProps) {
  const tree = categoryTree(categories);
  const [createParentId, setCreateParentId] = useState<string | null | undefined>();
  const [editingId, setEditingId] = useState<string>();
  const [archiveId, setArchiveId] = useState<string>();
  const [archivingId, setArchivingId] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const managerRef = useRef<HTMLElement>(null);
  const archiveTriggerRef = useRef<HTMLElement | null>(null);
  const activeById = new Map(categories.filter((category) => !category.archived).map((category) => [category.id, category]));

  const restoreArchiveFocus = () => {
    window.setTimeout(() => {
      if (archiveTriggerRef.current?.isConnected) {
        archiveTriggerRef.current.focus();
      } else {
        managerRef.current?.focus();
      }
    }, 0);
  };

  const beginArchive = (target: HTMLButtonElement, id: string) => {
    archiveTriggerRef.current = target;
    setArchiveId(id);
  };

  const create = async (name: string, sortOrder: number): Promise<boolean> => {
    const result = await onCreate({ name, sortOrder, ...(createParentId ? { parentId: createParentId } : {}) });
    if (result) {
      setCreateParentId(undefined);
      setError(undefined);
      setMessage(`${result.name} was added.`);
      return true;
    }
    return false;
  };

  const update = async (category: ManagedInventoryCategory, name: string, sortOrder: number): Promise<boolean> => {
    let result: ManagedInventoryCategory | undefined;
    try {
      result = await onUpdate(category.id, { name, sortOrder }, category.version);
    } catch (caught: unknown) {
      const status = typeof caught === "object" && caught !== null && "status" in caught ? (caught as { status?: unknown }).status : undefined;
      const code = typeof caught === "object" && caught !== null && "code" in caught ? (caught as { code?: unknown }).code : undefined;
      if (status === 409 && code === "version_conflict") {
        setEditingId(undefined);
        setError(caught instanceof Error ? caught.message : "This category changed in another tab. Reload it and try again.");
        return false;
      }
      throw caught;
    }
    if (result) {
      setEditingId(undefined);
      setError(undefined);
      setMessage(`${result.name} was updated.`);
      return true;
    }
    return false;
  };

  const archive = async (category: ManagedInventoryCategory) => {
    if (archivingId !== undefined) return;
    setArchivingId(category.id);
    try {
      const archived = await onArchive(category.id, category.version);
      if (archived) { setArchiveId(undefined); setError(undefined); setMessage(`${category.name} was archived.`); restoreArchiveFocus(); }
    } catch (caught: unknown) {
      const status = typeof caught === "object" && caught !== null && "status" in caught ? (caught as { status?: unknown }).status : undefined;
      const code = typeof caught === "object" && caught !== null && "code" in caught ? (caught as { code?: unknown }).code : undefined;
      if (status === 409 && code === "version_conflict") { setArchiveId(undefined); restoreArchiveFocus(); }
      setError(caught instanceof Error ? caught.message : "That category could not be archived. Nothing changed.");
    } finally {
      setArchivingId(undefined);
    }
  };

  return <section ref={managerRef} className={`${embedded ? "" : "surface settings-section "}category-manager${embedded ? " category-manager-embedded" : ""}`} aria-labelledby="category-manager-title" tabIndex={-1}>
    <div className="category-manager-heading"><div><span className="eyebrow">Inventory taxonomy</span><h2 id="category-manager-title">Manage inventory categories</h2><p>Use categories and one-level subcategories to describe where an item belongs. Existing items can remain unassigned.</p><small className="category-manager-explanation">Categories organize your workspace. Item type controls stock rules.</small></div><button type="button" className="button button-primary" onClick={() => { setEditingId(undefined); setCreateParentId(null); }} disabled={createParentId !== undefined || archivingId !== undefined}><Icon name="plus" size={16} />New category</button></div>
    {message && <p className="category-manager-message" role="status">{message}</p>}
    {error && <p className="category-manager-error" role="alert">{error}</p>}
    {createParentId === null && <CategoryForm title="Create top-level category" submitLabel="Add category" onSubmit={create} onCancel={() => setCreateParentId(undefined)} />}
    {tree.length === 0 && createParentId === undefined ? <div className="category-manager-empty"><Icon name="layers" size={20} /><span>No active categories yet. Add a top-level category to get started.</span></div> : <div className="category-tree">{tree.map(({ category, children }) => {
      const editing = editingId === category.id;
      return <div className="category-tree-group" key={category.id}>
        {editing ? <CategoryForm title={`Edit ${categoryDisplayLabel(category)}`} initialName={category.name} initialSortOrder={category.sortOrder} submitLabel="Save changes" onSubmit={(name, sortOrder) => update(category, name, sortOrder)} onCancel={() => setEditingId(undefined)} /> : <CategoryRow category={category} disabled={archivingId !== undefined} onEdit={() => { setCreateParentId(undefined); setEditingId(category.id); }} onAddChild={() => { setEditingId(undefined); setCreateParentId(category.id); }} onArchive={(target) => beginArchive(target, category.id)} />}
        {archiveId === category.id && <ArchiveConfirmation category={category} busy={archivingId === category.id} onCancel={() => { setArchiveId(undefined); restoreArchiveFocus(); }} onConfirm={() => { void archive(category); }} />}
        {createParentId === category.id && <CategoryForm title={`Create subcategory under ${category.name}`} submitLabel="Add subcategory" onSubmit={create} onCancel={() => setCreateParentId(undefined)} />}
        {children.length > 0 && <div className="category-children">{children.map((child) => {
          const childEditing = editingId === child.id;
          return <div className="category-child-group" key={child.id}>{childEditing ? <CategoryForm title={`Edit ${categoryDisplayLabel(child, category)}`} initialName={child.name} initialSortOrder={child.sortOrder} submitLabel="Save changes" onSubmit={(name, sortOrder) => update(child, name, sortOrder)} onCancel={() => setEditingId(undefined)} /> : <CategoryRow category={child} parent={category} disabled={archivingId !== undefined} onEdit={() => { setCreateParentId(undefined); setEditingId(child.id); }} onArchive={(target) => beginArchive(target, child.id)} />} {archiveId === child.id && <ArchiveConfirmation category={child} busy={archivingId === child.id} onCancel={() => { setArchiveId(undefined); restoreArchiveFocus(); }} onConfirm={() => { void archive(child); }} />}</div>;
        })}</div>}
      </div>;
    })}</div>}
    {createParentId !== undefined && createParentId !== null && !activeById.has(createParentId) && <p className="form-error" role="alert">The selected parent is no longer active. Reload categories and try again.</p>}
  </section>;
}

export function CategorySelection({ categories, value, onChange, required = true, disabled = false, ariaInvalid = false, ariaDescribedBy }: { categories: readonly ManagedInventoryCategory[]; value?: string; onChange: (id: string) => void; required?: boolean; disabled?: boolean; ariaInvalid?: boolean; ariaDescribedBy?: string }) {
  const active = categories.filter((category) => !category.archived);
  const tree = categoryTree(active);
  const hintId = useId();
  const describedBy = [hintId, ariaDescribedBy].filter(Boolean).join(" ");
  return <label className="form-field inventory-category-selection"><span>Category <small>{required ? "(required)" : "(optional)"}</small></span><select required={required} disabled={disabled} aria-invalid={ariaInvalid || (required && !value)} aria-describedby={describedBy} value={value ?? ""} onChange={(event) => onChange(event.target.value)}><option value="">Choose a category</option>{tree.map(({ category, children }) => <optgroup key={category.id} label={category.name}><option value={category.id}>{category.name}</option>{children.map((child) => <option key={child.id} value={child.id}>{category.name} / {child.name}</option>)}</optgroup>)}</select><small id={hintId} className="field-hint">This is the managed category shown in inventory. BenchLedger keeps the item type separately for matching.</small></label>;
}

export function managedCategoryForId(categories: readonly ManagedInventoryCategory[], id: string | undefined): ManagedInventoryCategory | undefined {
  return categories.find((category) => !category.archived && category.id === id);
}

export function selectedCategoryLabel(categories: readonly ManagedInventoryCategory[], id: string | undefined): string | undefined {
  const category = managedCategoryForId(categories, id);
  if (!category) return undefined;
  const parent = category.parentId ? categories.find((candidate) => candidate.id === category.parentId) : undefined;
  return categoryDisplayLabel(category, parent);
}
