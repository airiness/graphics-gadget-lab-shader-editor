import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn.js";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4",
    {
        variants: {
            variant: {
                default: "bg-primary text-primary-foreground hover:bg-primary/90",
                primary: "bg-accent text-accent-foreground hover:bg-accent/90",
                outline: "border border-border bg-transparent hover:bg-accent-soft",
                ghost: "hover:bg-accent-soft hover:text-foreground",
                subtle: "bg-secondary text-foreground hover:bg-secondary/80",
                destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
            },
            size: {
                default: "h-9 px-4 py-2",
                sm: "h-8 rounded-md px-3 text-xs",
                lg: "h-10 rounded-md px-6",
                icon: "h-9 w-9",
            },
        },
        defaultVariants: {
            variant: "default",
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
