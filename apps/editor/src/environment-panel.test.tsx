import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EnvironmentControls } from "./environment-panel.js";
import type { EnvironmentWorkflow } from "./environment-workflow.js";
afterEach(cleanup);
function workflow(busy: boolean) {
    const candidate = { deployment: "Release", toolSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) };
    const snapshot = { busy, message: "Final-location verification", candidates: [candidate], registry: null, operations: [], canRetry: false };
    return { candidate, host: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {}, publish: vi.fn(), cancel: vi.fn(),
    } as unknown as EnvironmentWorkflow };
}
it("keeps deployment selection explicit", () => {
    const w = workflow(false); render(<EnvironmentControls workflow={w.host} close={vi.fn()} />);
    expect(w.host.publish).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Publish and use" }));
    expect(w.host.publish).toHaveBeenCalledWith(w.candidate);
});
it("keeps cancellation available while imports and dismissal are disabled", () => {
    const w = workflow(true), close = vi.fn(); render(<EnvironmentControls workflow={w.host} close={close} />);
    expect(screen.getByRole("button", { name: "Publish and use" }).closest("fieldset")?.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" })); expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel operation" })); expect(w.host.cancel).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe("Final-location verification");
});
