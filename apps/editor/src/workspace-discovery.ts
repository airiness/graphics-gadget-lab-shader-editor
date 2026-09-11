import type { WorkspaceDiscoveryId } from "./host-io.js";

/** Invoke admission and channel settlement deserialize separate objects for the same ID. */
export function isCurrentWorkspaceDiscovery(
    watching: { readonly uri: string; readonly discoveryId: WorkspaceDiscoveryId } | null,
    uri: string,
    discoveryId: WorkspaceDiscoveryId,
): boolean {
    return watching !== null && watching.uri === uri && watching.discoveryId.sequence === discoveryId.sequence;
}
