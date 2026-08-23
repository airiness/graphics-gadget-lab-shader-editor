import * as React from "react";
import { cn } from "./cn.js";

/**
 * One action unit: a row of kit Buttons with fixed 8px spacing and
 * shared alignment (document I/O rows, dialog footers). Order and
 * variant hierarchy belong to the caller; spacing and stacking belong
 * here, so a button row can never degrade into loose inline text.
 */
export const ButtonGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function ButtonGroup({ className, ...props }, ref) {
        return <div ref={ref} className={cn("inline-flex items-center gap-2", className)} {...props} />;
    },
);
