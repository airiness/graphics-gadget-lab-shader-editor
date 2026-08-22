import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

/**
 * The editor button design language — one base, explicit variants:
 *
 *   primary     genuinely strong main action (theme primary color;
 *               reserved — not "important")
 *   secondary   clear ordinary actions (Open Descriptor, Load, Generate)
 *   toolbar     canvas toolbar actions (Auto Layout, future Fit/Snap)
 *   ghost       low-priority auxiliary actions
 *   icon        compact 26×26 square controls (library bulk controls)
 *   destructive reserved for destructive actions
 *
 * Geometry: 30px normal / 26px compact / 26×26 icon, 5px radius, a 1px
 * visible border, 9–12px horizontal padding, 13–14px icons, nowrap.
 * States: rest (raised off the panel, visible border), hover (brighter
 * background + border + text), pressed (translateY(1px) + inset shadow —
 * physical feedback beyond color), and an accent focus ring for keyboard.
 */
const buttonVariants = cva(
    "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border text-[13px] font-medium leading-none transition-[color,background-color,border-color,transform,box-shadow] active:translate-y-px active:shadow-[inset_0_2px_5px_rgba(0,0,0,0.45)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                primary: "border-primary/50 bg-primary text-primary-foreground hover:border-primary hover:bg-primary/90",
                secondary: "border-border bg-raised text-foreground hover:border-border-hi hover:bg-raised-hi",
                toolbar: "border-border bg-background text-muted-foreground hover:border-border-hi hover:bg-raised hover:text-foreground",
                ghost: "border-transparent bg-transparent text-muted-foreground hover:border-border-soft hover:bg-raised hover:text-foreground",
                icon: "border-border bg-raised text-muted-foreground hover:border-border-hi hover:bg-raised-hi hover:text-foreground",
                destructive:
                    "border-destructive/60 bg-[color-mix(in_srgb,var(--destructive)_16%,var(--panel-hi))] text-[var(--error)] hover:border-destructive hover:bg-[color-mix(in_srgb,var(--destructive)_26%,var(--panel-hi))]",
            },
            size: {
                default: "h-[30px] px-3",
                compact: "h-[26px] px-2.5 text-xs",
                icon: "h-[26px] w-[26px] p-0",
            },
        },
        defaultVariants: {
            variant: "secondary",
            size: "default",
        },
    },
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
        VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { className, variant, size, type = "button", ...props },
    ref,
) {
    return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { buttonVariants };
