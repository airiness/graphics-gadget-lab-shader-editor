import type { KeyboardEvent } from "react";

/** Move focus and selection together, using the existing tab activation intent. */
export function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const list = event.currentTarget.closest('[role="tablist"]');
    if (list === null) return;
    const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('button[role="tab"]'))
        .filter(tab => !tab.disabled && tab.closest('[role="tablist"]') === list);
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0 || tabs.length === 0) return;
    let next: number;
    switch (event.key) {
        case "ArrowRight": case "ArrowDown": next = (index + 1) % tabs.length; break;
        case "ArrowLeft": case "ArrowUp": next = (index + tabs.length - 1) % tabs.length; break;
        case "Home": next = 0; break;
        case "End": next = tabs.length - 1; break;
        default: return;
    }
    const target = tabs[next];
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    target.focus();
    target.click();
}
