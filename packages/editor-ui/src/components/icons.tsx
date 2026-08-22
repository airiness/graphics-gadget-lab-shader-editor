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
