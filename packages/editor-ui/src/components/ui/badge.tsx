import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

const badgeVariants = cva(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
    {
        variants: {
            variant: {
                default: "border-border bg-secondary text-foreground",
                outline: "border-border text-foreground",
                ok: "border-transparent bg-[color-mix(in_srgb,var(--ok)_18%,transparent)] text-[var(--ok)]",
                warn: "border-transparent bg-[color-mix(in_srgb,var(--warn)_18%,transparent)] text-[var(--warn)]",
                error: "border-transparent bg-[color-mix(in_srgb,var(--error)_18%,transparent)] text-[var(--error)]",
                accent: "border-transparent bg-accent-soft text-accent",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

export interface BadgeProps
    extends React.HTMLAttributes<HTMLSpanElement>,
        VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Small status dot used inside a Badge. */
export function BadgeDot({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
    return (
        <span
            aria-hidden
            className={cn("inline-block size-2 shrink-0 rounded-full bg-current opacity-80", className)}
            {...props}
        />
    );
}

export { badgeVariants };
