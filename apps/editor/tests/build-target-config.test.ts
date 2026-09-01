import { describe, expect, it } from "vitest";
import {
    buildTargetOptions,
    createBuildTargetConfiguration,
} from "../src/build-target-config.js";

describe("build target configuration", () => {
    it("adds targets proven by a later handshake without losing the explicit default", () => {
        const configuration = createBuildTargetConfiguration();

        expect(buildTargetOptions(configuration, null)).toEqual(["gglab-dx12"]);
        expect(buildTargetOptions(configuration, ["gglab-dx12", "gglab-vulkan13"])).toEqual([
            "gglab-dx12",
            "gglab-vulkan13",
        ]);
    });

    it("keeps the current configuration first and removes duplicate choices", () => {
        const configuration = createBuildTargetConfiguration("gglab-vulkan13");

        expect(
            buildTargetOptions(configuration, [
                "gglab-dx12",
                "gglab-vulkan13",
                "gglab-vulkan13",
            ]),
        ).toEqual(["gglab-vulkan13", "gglab-dx12"]);
    });
});
