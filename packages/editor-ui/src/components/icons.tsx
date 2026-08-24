/**
 * Minimal inline action icons (presentation only, currentColor).
 * Kept dependency-free: 1.2px stroke, 14px box, sized for the chrome kit's
 * small buttons.
 */
export interface IconProps {
    readonly size?: number;
}

/** Four-quadrant layout glyph (auto layout). */
export function LayoutIcon(props: IconProps = {}) {
    const size = props.size ?? 14;
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
            <rect x="1" y="1" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="1" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="1" y="8" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <rect x="8" y="8" width="5" height="5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

/** Double downward chevron (collapse all sections). */
export function ChevronsDownIcon(props: IconProps = {}) {
    const size = props.size ?? 13;
    return (
        <svg width={size} height={size} viewBox="0 0 13 13" aria-hidden>
            <path d="M2.5 3l4 3.5L10.5 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 7.5L6.5 11l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Double upward chevron (expand all sections). */
export function ChevronsUpIcon(props: IconProps = {}) {
    const size = props.size ?? 13;
    return (
        <svg width={size} height={size} viewBox="0 0 13 13" aria-hidden>
            <path d="M2.5 10L6.5 6.5 10.5 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.5 5.5L6.5 2l4 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Trash glyph (node removal — the card's delete action). */
export function TrashIcon(props: IconProps = {}) {
    const size = props.size ?? 14;
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
            <path d="M2.8 4h8.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <path d="M5.4 4V2.7h3.2V4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3.7 4l.6 7.5h5.4L10.3 4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M5.9 6v3.4M8.1 6v3.4" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    );
}

/** Side panel collapse glyph (panel divider, no action mark). */
export function PanelCloseIcon(props: IconProps = {}) {
    const size = props.size ?? 13;
    return (
        <svg width={size} height={size} viewBox="0 0 13 13" aria-hidden>
            <rect x="1" y="1.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="1.5" x2="5.5" y2="11.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
    );
}

/** Undo glyph — a curved arrow bending back toward the start. */
export function UndoIcon(props: IconProps = {}) {
    const size = props.size ?? 14;
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
            <path d="M5.5 2.6L2.2 5.9 5.5 9.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2.2 5.9H9.2a3.4 3.4 0 0 1 0 6.8H8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    );
}

/** Redo glyph — a curved arrow bending forward again (the mirror of undo). */
export function RedoIcon(props: IconProps = {}) {
    const size = props.size ?? 14;
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
            <path d="M8.5 2.6L11.8 5.9 8.5 9.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M11.8 5.9H4.8a3.4 3.4 0 0 0 0 6.8H6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    );
}

/** Side panel expand glyph (panel divider + outward arrow). */
export function PanelOpenIcon(props: IconProps = {}) {
    const size = props.size ?? 13;
    return (
        <svg width={size} height={size} viewBox="0 0 13 13" aria-hidden>
            <rect x="1" y="1.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="1.5" x2="5.5" y2="11.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7.6 5.4l1.9 1.6-1.9 1.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

/** Document glyph (open a descriptor file). */
export function FileIcon(props: IconProps = {}) {
    const size = props.size ?? 14;
    return (
        <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
            <path d="M3.5 1.2h5l2.5 2.6v9H3.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M8.5 1.2v2.6H11" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
            <line x1="5.2" y1="7" x2="8.8" y2="7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <line x1="5.2" y1="9.4" x2="8.8" y2="9.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
    );
}
