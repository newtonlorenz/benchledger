import { useState, type ReactNode } from "react";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "./ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Label } from "./ui/label";
/** Caller owns search policy; Command owns selection and Popover owns dismissal. */
export function SearchCombobox({ label, value, onValueChange, options, onSelect, placeholder, disabled = false, loading = false, empty }: {
 label: string; value: string; onValueChange(value: string): void; options: { id: string; content: ReactNode }[];
 onSelect(id: string): void; placeholder?: string; disabled?: boolean; loading?: boolean; empty: string;
}) {
 const [open,setOpen] = useState(false);
 const [host,setHost] = useState<HTMLDivElement | null>(null);
 return <Popover open={open} onOpenChange={setOpen}><Command label={label} ref={setHost} shouldFilter={false} loop className="search-combobox">
 <PopoverAnchor asChild><div><Label className="form-field"><span>{label}</span><CommandInput aria-label={label} aria-expanded={open} value={value} onValueChange={next => { onValueChange(next); setOpen(true); }} onFocus={() => setOpen(true)} placeholder={placeholder} disabled={disabled}/></Label></div></PopoverAnchor>
 {loading && <span role="status" aria-label="Searching">Searching…</span>}
 <PopoverContent container={host} className="search-results-popover" align="start" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => { if (host?.querySelector('[data-slot="command-input"]') === event.target) event.preventDefault(); }}>
 <CommandList label={`${label} results`}>{options.map(option => <CommandItem key={option.id} value={option.id} className="catalog-option" onMouseDown={event => event.preventDefault()} onSelect={() => { onSelect(option.id); setOpen(false); }}>{option.content}</CommandItem>)}<CommandEmpty>{empty}</CommandEmpty></CommandList>
 </PopoverContent></Command></Popover>;
}
