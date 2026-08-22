import * as React from "react";
import { cn } from "./cn.js";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    function Input({ className, ...props }, ref) {
        return (
            <input
                ref={ref}
                className={cn(
                    "flex h-9 w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50",
                    className,
                )}
                {...props}
            />
        );
    },
);
