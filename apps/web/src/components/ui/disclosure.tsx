import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "./collapsible";
import { cn } from "../../lib/utils";

const DisclosureState = React.createContext(false);
function Disclosure({ open, defaultOpen = false, onOpenChange, children, ...props }: React.ComponentProps<typeof Collapsible>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const expanded = open ?? localOpen;
  return <DisclosureState.Provider value={expanded}><Collapsible {...props} open={expanded} onOpenChange={(value) => { setLocalOpen(value); onOpenChange?.(value); }} data-disclosure="root">{children}</Collapsible></DisclosureState.Provider>;
}
function DisclosureTrigger({ children, className, ...props }: React.ComponentProps<typeof CollapsibleTrigger>) {
  return <CollapsibleTrigger {...props} className={cn("flex min-h-10 w-full items-center justify-between gap-3 rounded-md py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&[data-state=open]>svg:last-child]:rotate-180", className)} data-disclosure="trigger">{children}<ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></CollapsibleTrigger>;
}
function DisclosureContent(props: React.ComponentProps<typeof CollapsibleContent>) {
  const open = React.useContext(DisclosureState);
  return <CollapsibleContent {...props} forceMount hidden={!open} data-disclosure="content" />;
}
export { Disclosure, DisclosureTrigger, DisclosureContent };
