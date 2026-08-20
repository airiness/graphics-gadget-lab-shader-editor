import { describe, expect, it } from "vitest";
import { corePackageName, getCorePackageName } from "../src/index.js";

describe("shader graph core package identity", () => {
    it("exposes a stable package identity", () => {
        expect(corePackageName).toBe("@gglab/shader-graph-core");
        expect(getCorePackageName()).toBe(corePackageName);
    });
});
