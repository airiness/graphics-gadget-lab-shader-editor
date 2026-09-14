import { expect, it } from "vitest";
import { createDesktopFileChannel } from "../src/host-io.js";
import { canonicalWorkspaceUriFromHost } from "../src/workspace-session.js";
import { isCurrentWorkspaceDiscovery } from "../src/workspace-discovery.js";

it("accepts discovery results decoded separately from invoke admission", async () => {
    const uri = canonicalWorkspaceUriFromHost("file:///fixtures/");
    let deliver: (message: unknown) => void = () => {};
    const channel = createDesktopFileChannel({
        invoke: async () => ({ sequence: 1 }),
        createChannel: receive => { deliver = receive; return {}; },
        readTextFile: async () => "",
    });
    const attempt = await channel.discoverWorkspace(uri);
    deliver({ kind: "changed", discoveryId: { sequence: 1 }, snapshot: {
        root: { canonicalWorkspaceUri: uri, displayPath: "D:/fixtures" },
        documents: [{ relativePath: "SurfaceTextureGolden.shadergraph", canonicalDocumentUri: "file:///fixtures/SurfaceTextureGolden.shadergraph" }], discoveryRevisionToken: "revision:1",
    } });
    const settlement = await attempt.result;
    expect(settlement).toMatchObject({ kind: "changed", snapshot: { documents: [{ relativePath: "SurfaceTextureGolden.shadergraph" }] } });
    expect(settlement.discoveryId).not.toBe(attempt.discoveryId);
    expect(isCurrentWorkspaceDiscovery({ uri, discoveryId: attempt.discoveryId }, uri, settlement.discoveryId)).toBe(true);
});

it("rejects superseded roots, attempts and cleared bindings", () => {
    const watching = { uri: "file:///fixtures/", discoveryId: { sequence: 2 } };
    expect(isCurrentWorkspaceDiscovery(watching, watching.uri, { sequence: 1 })).toBe(false);
    expect(isCurrentWorkspaceDiscovery(watching, "file:///other/", { sequence: 2 })).toBe(false);
    expect(isCurrentWorkspaceDiscovery(null, watching.uri, { sequence: 2 })).toBe(false);
});
