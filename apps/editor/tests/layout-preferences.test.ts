import { afterEach, describe, expect, it, vi } from "vitest";
import { bindLayoutPreferences, readLayoutPreferences, type LayoutPreferences } from "../src/layout-preferences.js";

const initial: LayoutPreferences = { libraryOpen: true, inspectorOpen: true, bottomPanelOpen: true, bottomPanelHeight: 220, bottomPanelTab: "output", sidebarPanel: "nodes" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());
describe("layout preferences", () => {
    it("rejects unknown fields, invalid sizes and native state", () => {
        expect(readLayoutPreferences(initial)).toEqual(initial);
        for (const value of [null, { ...initial, current: true }, { ...initial, bottomPanelHeight: 481 }, { ...initial, bottomPanelHeight: 100.5 }, { ...initial, sidebarPanel: "runtime" }]) {
            expect(() => readLayoutPreferences(value)).toThrow();
        }
    });
    it("restores layout without writing startup defaults", async () => {
        vi.useFakeTimers();
        const apply = vi.fn(), save = vi.fn(async () => {});
        const restored = { ...initial, bottomPanelTab: "problems" as const };
        const binding = bindLayoutPreferences({ readLayoutPreferences: async () => restored, saveLayoutPreferences: save }, initial, apply, vi.fn());
        await binding.loaded;
        expect(apply).toHaveBeenCalledWith(restored);
        await vi.runAllTimersAsync(); await binding.dispose();
        expect(save).not.toHaveBeenCalled();
    });
    it("does not overwrite a local interaction with a late stored layout", async () => {
        vi.useFakeTimers();
        const read = deferred<LayoutPreferences | null>(), apply = vi.fn(), save = vi.fn(async () => {});
        const binding = bindLayoutPreferences({ readLayoutPreferences: () => read.promise, saveLayoutPreferences: save }, initial, apply, vi.fn());
        const changed = { ...initial, inspectorOpen: false };
        binding.observe(changed);
        expect(save).not.toHaveBeenCalled();
        read.resolve({ ...initial, sidebarPanel: "explorer" }); await binding.loaded;
        expect(apply).not.toHaveBeenCalled();
        await vi.runAllTimersAsync(); await binding.dispose();
        expect(save).toHaveBeenCalledExactlyOnceWith(changed);
    });
    it("coalesces drag updates, serializes writes and flushes the last value", async () => {
        vi.useFakeTimers();
        const firstWrite = deferred<void>(), save = vi.fn().mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(undefined);
        const binding = bindLayoutPreferences({ readLayoutPreferences: async () => null, saveLayoutPreferences: save }, initial, vi.fn(), vi.fn());
        await binding.loaded;
        for (const bottomPanelHeight of [230, 240, 250]) binding.observe({ ...initial, bottomPanelHeight });
        await vi.advanceTimersByTimeAsync(200);
        expect(save).toHaveBeenCalledExactlyOnceWith({ ...initial, bottomPanelHeight: 250 });
        binding.observe({ ...initial, bottomPanelHeight: 300 });
        const done = binding.dispose();
        expect(save).toHaveBeenCalledOnce();
        firstWrite.resolve(); await done;
        expect(save).toHaveBeenLastCalledWith({ ...initial, bottomPanelHeight: 300 });
    });
    it("preserves unreadable preferences and ignores a superseded reader", async () => {
        const error = new Error("unknown version"), report = vi.fn(), save = vi.fn(async () => {});
        const binding = bindLayoutPreferences({ readLayoutPreferences: async () => { throw error; }, saveLayoutPreferences: save }, initial, vi.fn(), report);
        await binding.loaded; binding.observe({ ...initial, libraryOpen: false }); await binding.dispose();
        expect(report).toHaveBeenCalledWith(error); expect(save).not.toHaveBeenCalled();
        const read = deferred<LayoutPreferences | null>(), apply = vi.fn();
        const obsolete = bindLayoutPreferences({ readLayoutPreferences: () => read.promise, saveLayoutPreferences: save }, initial, apply, report);
        await obsolete.dispose(); read.resolve({ ...initial, libraryOpen: false }); await obsolete.loaded;
        expect(apply).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    });
});
