import { describe, expect, it } from "vitest";
import { clientPackageName, getClientPackageName } from "../src/index.js";

describe("shader toolchain client package identity", () => {
    it("exposes a stable package identity", () => {
        expect(clientPackageName).toBe("@gglab/shader-toolchain-client");
        expect(getClientPackageName()).toBe(clientPackageName);
    });
});
