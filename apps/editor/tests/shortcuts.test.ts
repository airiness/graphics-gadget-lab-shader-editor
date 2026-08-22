/**
 * Editor keyboard shortcuts — the save-shortcut classification (the
 * app's keydown listener consults this one authority).
 */
import { describe, expect, it } from "vitest";
import { saveShortcutOf } from "../src/shortcuts.js";

const KEYS = { ctrlKey: false, metaKey: false, shiftKey: false, key: "s" };

describe("save shortcut classification", () => {
    it("Ctrl+S saves", () => {
        expect(saveShortcutOf({ ...KEYS, ctrlKey: true, key: "s" })).toBe("save");
        expect(saveShortcutOf({ ...KEYS, ctrlKey: true, key: "S" })).toBe("save");
    });

    it("Ctrl+Shift+S saves-as", () => {
        expect(saveShortcutOf({ ...KEYS, ctrlKey: true, shiftKey: true, key: "s" })).toBe("save-as");
    });

    it("Cmd variants are included (one rule, both modifiers)", () => {
        expect(saveShortcutOf({ ...KEYS, metaKey: true })).toBe("save");
        expect(saveShortcutOf({ ...KEYS, metaKey: true, shiftKey: true })).toBe("save-as");
    });

    it("everything else is not a save shortcut", () => {
        expect(saveShortcutOf({ ...KEYS })).toBeNull(); // bare s
        expect(saveShortcutOf({ ...KEYS, shiftKey: true })).toBeNull(); // shift+s
        expect(saveShortcutOf({ ...KEYS, ctrlKey: true, key: "d" })).toBeNull(); // ctrl+d
        expect(saveShortcutOf({ ...KEYS, ctrlKey: true, shiftKey: true, key: "S" })).toBe("save-as");
    });
});
