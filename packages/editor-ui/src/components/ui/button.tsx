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
 *   destructive reserved for destructive actions (the "danger" slot)
 *
 * FROZEN GEOMETRY (verified by the button-kit lock test):
 *   - 28px text buttons / 26×26 icon buttons, the --r-1 radius,
 *   - ONE uniform 1px NEUTRAL border on every variant (the edge never
 *     varies in width or tint — a border-color difference reads as a
 *     width difference; variants are distinguished by fill/brightness),
 *   - 10px horizontal padding, 6px icon gap,
 *   - 14px icons, nowrap,
 *   - text on the type scale (--type-body / --weight-strong — 12px/600),
 *   - rest (raised off the panel, visible border — a button must read as
 *     a button in a still screenshot, never only on hover),
 *   - hover (brighter background + border + text),
 *   - pressed (translateY(1px) + inset shadow — physical feedback beyond
 *     color),
 *   - focus-visible (a 2px ring, 1px offset — for keyboard),
 *   - disabled (no pointer response, 50% opacity).
 *
 * LABEL OPTICS: CJK line metrics (the rendered UI families) reserve a
 * large descent region, so the Latin cap band of a flex-centered
 * natural line box sits above the optical center. Labels carry the
 * measured correction (1.5px down — the midpoint of the candidate
 * families' 1.0-2.4px band); adjust in this ONE place if the rendered
 * family changes.
 */
const buttonVariants = cva(
    "relative inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--r-1)] border text-[length:var(--type-body)] font-semibold leading-none transition-[color,background-color,border-color,transform,box-shadow] active:translate-y-px active:shadow-[inset_0_2px_5px_rgba(0,0,0,0.45)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                primary: "border-border bg-primary text-primary-foreground hover:bg-primary/90",
                secondary: "border-border bg-raised text-foreground hover:border-border-hi hover:bg-raised-hi",
                toolbar: "border-border bg-background text-muted-foreground hover:border-border-hi hover:bg-raised hover:text-foreground",
                ghost: "border-border bg-panel text-muted-foreground hover:border-border-hi hover:bg-raised hover:text-foreground",
                icon: "border-border bg-raised text-muted-foreground hover:border-border-hi hover:bg-raised-hi hover:text-foreground",
                destructive:
                    "border-border bg-[color-mix(in_srgb,var(--destructive)_16%,var(--panel-hi))] text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--destructive)_26%,var(--panel-hi))]",
            },
            size: {
                default: "h-[28px] px-2.5",
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

/**
 * Label optics (applied below): raw text children are wrapped in a span
 * carrying the 1.5px optical correction (see LABEL OPTICS above) so the
 * Latin cap band sits on the optical center despite CJK line metrics.
 * Element children (icons, composites) pass through unchanged.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { className, variant, size, type = "button", children, ...props },
    ref,
) {
    return (
        <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props}>
            {React.Children.map(children, (child, index) =>
                React.isValidElement(child) || child == null ? (
                    child
                ) : (
                    <span key={index} className="inline-block [transform:translateY(1.5px)]">
                        {child}
                    </span>
                ),
            )}
        </button>
    );
});

export { buttonVariants };
