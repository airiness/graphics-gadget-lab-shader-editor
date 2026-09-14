import { EnvironmentContractError, environmentHostDiagnostic, readEnvironmentDiscoveryId, readEnvironmentDiscoverySettlement, readEnvironmentRepositoryHandle, type EnvironmentDiscoveryHost, type EnvironmentDiscoveryOutcome } from "@gglab/shader-toolchain-client";
import { isDesktopHost, type HostInvoke, type HostChannelFactory } from "./host-io.js";

/** Three allowlisted commands only. No caller path, publisher, argv or mutation request is forwarded. */
export function createEnvironmentDiscoveryHost(invoke: HostInvoke, createChannel: HostChannelFactory): EnvironmentDiscoveryHost {
    return {
        async chooseRepository() {
            try {
                const value = await invoke("shader-environment-choose-repository");
                return value === null ? null : readEnvironmentRepositoryHandle(value);
            } catch (error) { const d = environmentHostDiagnostic(error); throw new EnvironmentContractError(d.code, d.message, d.dataPath); }
        },
        async discover(repository) {
            const selected = { ...readEnvironmentRepositoryHandle(repository) };
            let admitted: string | null = null, received = false, raw: unknown;
            let settled = false;
            let finish!: (outcome: EnvironmentDiscoveryOutcome) => void;
            const completion = new Promise<EnvironmentDiscoveryOutcome>(resolve => { finish = resolve; });
            const deliver = (): void => {
                if (!settled && received && admitted !== null) {
                    settled = true; finish(readEnvironmentDiscoverySettlement(selected, admitted, raw));
                }
            };
            const channel = createChannel(value => { if (!received && !settled) { raw = value; received = true; deliver(); } });
            try {
                admitted = readEnvironmentDiscoveryId(await invoke("shader-environment-discover", { repositoryId: selected.repositoryId, channel }));
                deliver();
                return { discoveryId: admitted, completion };
            } catch (error) {
                settled = true; const diagnostic = environmentHostDiagnostic(error);
                finish({ status: "refused", diagnostic });
                throw new EnvironmentContractError(diagnostic.code, diagnostic.message, diagnostic.dataPath);
            }
        },
        async cancel(discoveryId) {
            readEnvironmentDiscoveryId(discoveryId);
            const result = await invoke("shader-environment-cancel-discovery", { discoveryId });
            if (typeof result !== "boolean") throw new EnvironmentContractError("invalid-shape", "Invalid discovery cancellation result");
            return result;
        },
    };
}
export async function createTauriEnvironmentDiscoveryHost(): Promise<EnvironmentDiscoveryHost | null> {
    if (!isDesktopHost(typeof window === "undefined" ? undefined : window)) return null;
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    return createEnvironmentDiscoveryHost(invoke, onMessage => { const channel = new Channel<unknown>(); channel.onmessage = onMessage; return channel; });
}
