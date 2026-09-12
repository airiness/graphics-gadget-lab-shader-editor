import { afterEach, describe, expect, it, vi } from "vitest";
import { bindWorkspaceResume, readWorkspaceResume, projectWorkspaceResume, sameResumeContext, type WorkspaceResume } from "../src/workspace-resume.js";
import { createWorkspaceSession, canonicalWorkspaceUriFromHost, canonicalDocumentUriFromHost, createDocumentSessionId } from "../src/workspace-session.js";
import { createSession, provenanceFromFile, provenanceFromImport, recordDocumentChange } from "../src/document-session.js";
import { fileRevisionTokenFromHost } from "../src/host-io.js";
import type { WorkspaceAuthoringState } from "../src/workspace-store.js";
import type { ShaderGraphDocument } from "@gglab/shader-graph-core";

const initial: WorkspaceResume = { workspaceUri: "file:///C:/graphs/", documentUris: [], activeUri: null, previewUri: null, environmentId: null, buildTarget: "dx12" };
const saved: WorkspaceResume = { ...initial, documentUris: ["file:///C:/graphs/a.shadergraph"], activeUri: "file:///C:/graphs/a.shadergraph", previewUri: "file:///C:/graphs/a.shadergraph", environmentId: "env-1" };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.useRealTimers());
describe("safe Workspace resume intent", () => {
    it("rejects native claims, unknown fields, duplicate tabs and dangling targets", () => {
        expect(readWorkspaceResume(saved)).toEqual(saved);
        for (const value of [null, { ...saved, current: true }, { ...saved, fileRevisionToken: "old" }, { ...saved, documentUris: [...saved.documentUris, ...saved.documentUris] }, { ...saved, activeUri: "missing" }, { ...saved, previewUri: undefined }, { ...saved, buildTarget: "" }]) {
            expect(() => readWorkspaceResume(value)).toThrow();
        }
    });
    it("does not replace saved tabs with startup defaults or revive an obsolete reader", async () => {
        vi.useFakeTimers(); const save = vi.fn(async () => {}), loaded = vi.fn();
        const binding = bindWorkspaceResume({ readWorkspaceResume: async () => saved, saveWorkspaceResume: save }, initial, loaded, vi.fn());
        await binding.loading; await vi.runAllTimersAsync(); await binding.dispose();
        expect(loaded).toHaveBeenCalledWith(saved); expect(save).not.toHaveBeenCalled();
        const read = deferred<WorkspaceResume | null>();
        const obsolete = bindWorkspaceResume({ readWorkspaceResume: () => read.promise, saveWorkspaceResume: save }, initial, loaded, vi.fn());
        await obsolete.dispose(); read.resolve(saved); await obsolete.loading;
        expect(loaded).toHaveBeenCalledTimes(1);
    });
    it("keeps local changes during hydration and serializes the final flush", async () => {
        vi.useFakeTimers(); const read = deferred<WorkspaceResume | null>(), firstWrite = deferred<void>();
        const save = vi.fn().mockImplementationOnce(() => firstWrite.promise).mockResolvedValue(undefined);
        const binding = bindWorkspaceResume({ readWorkspaceResume: () => read.promise, saveWorkspaceResume: save }, initial, vi.fn(), vi.fn());
        binding.observe(saved); read.resolve(null); await binding.loading;
        await vi.advanceTimersByTimeAsync(200); expect(save).toHaveBeenCalledExactlyOnceWith(saved);
        binding.observe({ ...saved, buildTarget: "vulkan" }); const done = binding.dispose();
        expect(save).toHaveBeenCalledOnce(); firstWrite.resolve(); await done;
        expect(save).toHaveBeenLastCalledWith({ ...saved, buildTarget: "vulkan" });
    });
    it("preserves saved intent across partial restore, cancellation and retry", async () => {
        vi.useFakeTimers(); const save = vi.fn(async () => {});
        const binding = bindWorkspaceResume({ readWorkspaceResume: async () => saved, saveWorkspaceResume: save }, initial, vi.fn(), vi.fn());
        await binding.loading; await binding.pause();
        const partial = { ...initial, buildTarget: "vulkan" };
        binding.observe(partial); await vi.runAllTimersAsync(); binding.resume(partial);
        await vi.runAllTimersAsync(); expect(save).not.toHaveBeenCalled();
        await binding.pause(); binding.observe(saved); binding.resume(saved);
        binding.observe(saved); await vi.runAllTimersAsync(); expect(save).not.toHaveBeenCalled();
        binding.observe({ ...saved, previewUri: null }); await binding.dispose();
        expect(save).toHaveBeenCalledExactlyOnceWith({ ...saved, previewUri: null });
    });
    it("drains the active write but discards queued pre-restore writes", async () => {
        vi.useFakeTimers(); const first = deferred<void>(), save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(undefined);
        const binding = bindWorkspaceResume({ readWorkspaceResume: async () => null, saveWorkspaceResume: save }, initial, vi.fn(), vi.fn());
        await binding.loading; binding.observe(saved); await vi.advanceTimersByTimeAsync(200);
        binding.observe({ ...saved, buildTarget: "vulkan" }); await vi.advanceTimersByTimeAsync(200);
        const paused = binding.pause(); first.resolve(); await paused;
        expect(save).toHaveBeenCalledOnce(); binding.resume(initial); await binding.dispose();
        expect(save).toHaveBeenCalledOnce();
    });
    it("never overwrites unreadable preferences and reports write failures", async () => {
        const error = new Error("invalid preferences"), report = vi.fn(), save = vi.fn(async () => {});
        const binding = bindWorkspaceResume({ readWorkspaceResume: async () => { throw error; }, saveWorkspaceResume: save }, initial, vi.fn(), report);
        await binding.loading; binding.observe(saved); await binding.dispose();
        expect(report).toHaveBeenCalledWith(error); expect(save).not.toHaveBeenCalled();
        const failing = bindWorkspaceResume({ readWorkspaceResume: async () => null, saveWorkspaceResume: async () => { throw error; } }, initial, vi.fn(), report);
        await failing.loading; failing.observe(saved); await failing.dispose(); expect(report).toHaveBeenCalledTimes(2);
    });
    it("projects only file intent and tolerates evidence invalidation without accepting edits or owner swaps", () => {
        const graph: ShaderGraphDocument = { schemaVersion: 1, graphId: "g", profile: "gglab.surface", profileVersion: 1, parameters: [], nodes: [], connections: [], editorMetadata: { nodes: {}, unknownFields: {} }, unknownFields: {} };
        const doc = createSession(createDocumentSessionId("a"), provenanceFromFile("C:/graphs/a.shadergraph"), graph,
            canonicalDocumentUriFromHost(saved.documentUris[0]!), fileRevisionTokenFromHost("fresh"));
        const untitled = createSession(createDocumentSessionId("untitled"), provenanceFromImport(), graph);
        const before: WorkspaceAuthoringState = { profileDescriptor: null, session: { ...createWorkspaceSession(), workspaceRoot: { canonicalWorkspaceUri: canonicalWorkspaceUriFromHost(initial.workspaceUri), displayPath: "C:/graphs" }, documents: [doc, untitled], activeDocumentId: doc.sessionId, preview: { targetDocumentId: doc.sessionId } } };
        expect(projectWorkspaceResume(before.session, "dx12")).toEqual({ ...saved, environmentId: null });
        const refreshed = { ...before, session: { ...before.session, documents: before.session.documents.map(d => ({ ...d, presentation: { ...d.presentation, emission: null, focus: null } })) } };
        expect(sameResumeContext(before, refreshed, true)).toBe(true);
        const edited = recordDocumentChange(doc, { ...graph, graphId: "new" }, "Rename graph");
        expect(sameResumeContext(before, { ...before, session: { ...before.session, documents: [edited, untitled] } }, true)).toBe(false);
        expect(sameResumeContext(before, { ...before, session: { ...before.session, activeDocumentId: untitled.sessionId } }, true)).toBe(false);
        expect(sameResumeContext(before, { ...before, session: { ...before.session, documents: [untitled, doc] } }, true)).toBe(false);
    });
});
