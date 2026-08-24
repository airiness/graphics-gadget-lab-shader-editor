import * as React from "react";
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import { cn } from "./cn.js";

export const Collapsible = CollapsiblePrimitive.Root;

export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export const CollapsibleContent = CollapsiblePrimitive.Content;

/**
 * A content region that collapses/expands. Section-level UI session state:
 * the state lives in this component tree (and the composition root when it
 * needs to), and never in the persisted `ShaderGraphDocument`.
 */
export function CollapsibleSection({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
    return <CollapsiblePrimitive.Root data-slot="collapsible-section" className={cn("flex flex-col", className)} {...props} />;
}
