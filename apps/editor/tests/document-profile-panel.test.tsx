import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { applyGraphEdit, parseSurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";
import { graph } from "./environment-probe-documents.js";
import { DocumentProfilePanel } from "../src/document-profile-panel.js";

afterEach(cleanup);
it("shows core conformance refusal without changing the document", () => {
    const document = graph(1);
    const descriptor = { ...parseSurfaceProfileDescriptor(JSON.stringify(canonicalV2Fixture)).value!, parameterClasses: [] };
    let current = document;
    const { container } = render(<DocumentProfilePanel document={document} catalog={[descriptor]} onApply={chosen => {
        const result = applyGraphEdit(current, { kind: "set-profile", profile: chosen.profileId, profileVersion: chosen.profileVersion }, { descriptor: chosen });
        if (result.status === "changed") current = result.document;
        return result;
    }} />);
    const root = within(container);
    fireEvent.change(root.getByRole("combobox", { name: "Requested profile" }), { target: { value: JSON.stringify(["gglab.surface", 2]) } });
    fireEvent.click(root.getByRole("button", { name: "Apply document profile" }));
    expect(root.getByRole("status").textContent).toContain("Profile change refused.");
    expect(root.getByRole("status").querySelectorAll("p").length).toBeGreaterThan(0);
    expect(current).toBe(document);
});
