import { useEffect, useRef } from "react";
import { bindLayoutPreferences, type LayoutPreferenceHost, type LayoutPreferences } from "./layout-preferences.js";

export function useLayoutPreferences(host: LayoutPreferenceHost | null, layout: LayoutPreferences, apply: (layout: LayoutPreferences) => void, report: (error: unknown) => void): void {
    const latest = useRef({ layout, apply, report });
    latest.current = { layout, apply, report };
    const binding = useRef<ReturnType<typeof bindLayoutPreferences> | null>(null);
    useEffect(() => {
        if (host === null) return;
        const current = bindLayoutPreferences(host, latest.current.layout, value => latest.current.apply(value), error => latest.current.report(error));
        binding.current = current;
        return () => { if (binding.current === current) binding.current = null; void current.dispose(); };
    }, [host]);
    const identity = JSON.stringify(layout);
    useEffect(() => { binding.current?.observe(latest.current.layout); }, [identity, host]);
}
