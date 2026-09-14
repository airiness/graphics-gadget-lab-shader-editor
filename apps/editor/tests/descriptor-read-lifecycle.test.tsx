import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { DescriptorPanel } from "@gglab/editor-ui";
import type { ComponentProps } from "react";
type PickedText = NonNullable<Awaited<ReturnType<NonNullable<ComponentProps<typeof DescriptorPanel>["openDescriptorFile"]>>>>;
import { canonicalV1Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v1.js";
import { canonicalV2Fixture } from "../../../packages/shader-graph-core/tests/fixtures/descriptor-v2.js";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const picked = (version: number): PickedText => ({ name: "descriptor.json", text: JSON.stringify(version === 1 ? canonicalV1Fixture : canonicalV2Fixture) });
afterEach(cleanup);
it("reads browser files without using a released React event and allows a same-file retry", async () => {
    const changed = vi.fn();
    const { container } = render(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} />);
    const input = container.querySelector("input")!;
    const text = vi.fn(async () => picked(2).text);
    await act(async () => { fireEvent.change(input, { target: { files: [{ name: "descriptor.json", text }] } }); });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "ready", descriptor: expect.objectContaining({ profileVersion: 2 }) }));
    await act(async () => { fireEvent.change(input, { target: { files: [{ name: "descriptor.json", text }] } }); });
    expect(text).toHaveBeenCalledTimes(2);
    expect(input.value).toBe("");
});
it("reports browser read failures as structured IO rejection", async () => {
    const changed = vi.fn();
    const { container } = render(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} />);
    await act(async () => { fireEvent.change(container.querySelector("input")!, { target: { files: [{ name: "missing.json", text: async () => { throw new Error("File unavailable"); } }] } }); });
    expect(changed).toHaveBeenCalledWith({ kind: "rejected", fileName: "missing.json", diagnosticCode: "IO", diagnosticMessage: "File unavailable" });
});
it("keeps the latest request authoritative even when it is cancelled", async () => {
    const first = deferred<PickedText | null>(), second = deferred<PickedText | null>(), changed = vi.fn();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container } = render(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} openDescriptorFile={open} />);
    const button = within(container).getByRole("button", { name: "Open descriptor file…" });
    fireEvent.click(button); fireEvent.click(button);
    await act(async () => { second.resolve(null); });
    await act(async () => { first.resolve(picked(1)); });
    expect(changed).not.toHaveBeenCalled();
});
it("drops pending reads on readonly admission and unmount", async () => {
    const first = deferred<PickedText | null>(), second = deferred<PickedText | null>(), changed = vi.fn();
    const open = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { container, rerender, unmount } = render(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} openDescriptorFile={open} />);
    fireEvent.click(within(container).getByRole("button", { name: "Open descriptor file…" }));
    rerender(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} openDescriptorFile={open} readOnly />);
    rerender(<DescriptorPanel state={{ kind: "empty" }} onStateChange={changed} openDescriptorFile={open} />);
    await act(async () => { first.resolve(picked(1)); });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(within(container).getByRole("button", { name: "Open descriptor file…" }));
    unmount();
    await act(async () => { second.reject(new Error("late IO failure")); });
    expect(changed).not.toHaveBeenCalled();
});
