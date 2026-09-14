/** Consumer of the main-owned Environment v1 proposal. No publication or native readiness authority. */
export const ENVIRONMENT_JSON_LIMIT = 16 * 1024 * 1024;
export const ENVIRONMENT_ROLES = {
    tool: "payload/gglab-shaderc.exe", runtime: "payload/GraphicsGadgetLab.exe",
    shaderSources: "payload/Shaders", surfaceProfile1: "payload/Shaders/Profiles/GGLab.Surface/1/descriptor.json",
    surfaceProfile2: "payload/Shaders/Profiles/GGLab.Surface/2/descriptor.json",
    previewProgram: "payload/Shaders/Programs/ShaderGraphPreview/descriptor.json",
    baseArtifacts: "payload/BaseArtifacts", assets: "payload/Assets", vulkanLayers: "payload/VulkanLayers",
} as const;
export const ENVIRONMENT_STATE_ROLES = {
    shaderCache: "ShaderCache", artifacts: "ShaderArtifacts", generatedSources: "Generated",
    previewPublications: "ShaderArtifacts/shader-preview", previewSessions: "ShaderArtifacts/shader-preview-sessions",
    observations: "ShaderArtifacts/shader-preview-sessions", derivedData: "DerivedDataCache", settings: "Settings", logs: "Logs",
} as const;
export interface EnvironmentDiagnostic { readonly code: string; readonly severity: "error"; readonly message: string; readonly dataPath: string }
export class EnvironmentContractError extends Error {
    readonly diagnostic: EnvironmentDiagnostic;
    constructor(code: string, message: string, dataPath = "$") {
        super(message);
        this.diagnostic = { code, severity: "error", message, dataPath };
    }
}
export function environmentRequire(condition: unknown, code: string, message: string, path = "$"): asserts condition {
    if (!condition) throw new EnvironmentContractError(code, message, path);
}
export function environmentObject(value: unknown, path = "$"): Record<string, unknown> {
    environmentRequire(value !== null && typeof value === "object" && !Array.isArray(value), "invalid-shape", "Expected an object", path);
    return value as Record<string, unknown>;
}
export function environmentExact(value: unknown, fields: readonly string[], path = "$"): Record<string, unknown> {
    const object = environmentObject(value, path);
    environmentRequire(Object.keys(object).length === fields.length && fields.every(key => Object.hasOwn(object, key)), "invalid-shape", "Unexpected or missing fields", path);
    return object;
}
/** Duplicate keys must be checked before JSON.parse can discard them. Depth is bounded for hostile input. */
export function parseEnvironmentJson(text: string): unknown {
    let bytes = 0;
    for (const character of text) { const c = character.codePointAt(0)!; bytes += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4; }
    environmentRequire(bytes <= ENVIRONMENT_JSON_LIMIT, "limit-exceeded", "JSON exceeds 16 MiB");
    let offset = 0;
    const whitespace = (): void => { while (/[ \t\r\n]/.test(text[offset] ?? "x")) offset++; };
    const fail = (): never => { throw new EnvironmentContractError("invalid-json", "Invalid JSON", `$@${offset}`); };
    const string = (): string => {
        const start = offset++;
        while (offset < text.length) {
            const char = text[offset++];
            if (char === "\\") offset++;
            else if (char === '"') { try { return JSON.parse(text.slice(start, offset)) as string; } catch { return fail(); } }
        }
        return fail();
    };
    const value = (depth: number): unknown => {
        if (depth > 128) return fail();
        whitespace();
        const char = text[offset];
        if (char === '"') return string();
        if (char === "{" || char === "[") {
            offset++; whitespace();
            const object: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
            const array: unknown[] = [];
            const end = char === "{" ? "}" : "]";
            if (text[offset] === end) { offset++; return char === "{" ? object : array; }
            for (;;) {
                whitespace();
                if (char === "{") {
                    if (text[offset] !== '"') return fail();
                    const key = string(); whitespace();
                    if (Object.hasOwn(object, key) || text[offset++] !== ":") return fail();
                    object[key] = value(depth + 1);
                } else array.push(value(depth + 1));
                whitespace();
                if (text[offset] === end) { offset++; return char === "{" ? object : array; }
                if (text[offset++] !== ",") return fail();
            }
        }
        const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset))?.[0];
        if (!token) return fail();
        offset += token.length;
        const result: unknown = JSON.parse(token);
        // Wire numeric fields are integers. Do not reinterpret Python float tokens as version integers.
        if (typeof result === "number" && (!Number.isSafeInteger(result) || /[.eE]/.test(token))) return fail();
        return result;
    };
    const result = value(0); whitespace();
    if (offset !== text.length) return fail();
    return result;
}
export function environmentLocator(value: unknown, path = "$"): string {
    environmentRequire(typeof value === "string" && value.length > 0 && value.length <= 240, "invalid-path", "Invalid locator length", path);
    for (const part of value.split("/")) {
        environmentRequire(/^[A-Za-z0-9_.-]+$/.test(part) && part !== "." && part !== ".." && !part.endsWith(".") && !/^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i.test(part), "invalid-path", "Unsafe locator component", path);
    }
    return value;
}
export function environmentCanonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(environmentCanonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        const object = value as Record<string, unknown>;
        return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${environmentCanonical(object[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}
export type EnvironmentHash = (ascii: string) => string;
export interface EnvironmentMember { readonly path: string; readonly size: number; readonly sha256: string }
export interface EnvironmentManifest {
    readonly manifestVersion: 1; readonly kind: "gglab.authoring-environment"; readonly environmentId: string;
    readonly producer: { readonly publisherVersion: "1.0.0"; readonly publisherSha256: string; readonly sourceRevision: string; readonly sourceDirty: boolean; readonly deployment: string };
    readonly roles: typeof ENVIRONMENT_ROLES;
    readonly writableState: { readonly root: "external"; readonly roles: typeof ENVIRONMENT_STATE_ROLES };
    readonly members: readonly EnvironmentMember[];
}
export function environmentIdentity(manifest: unknown, hash: EnvironmentHash): string {
    const body = { ...environmentObject(manifest) };
    delete body.environmentId;
    return `sha256:${hash("GGLab.Environment.v1\n" + environmentCanonical(body))}`;
}
export function readEnvironmentManifest(text: string, hash: EnvironmentHash): EnvironmentManifest {
    const m = environmentObject(parseEnvironmentJson(text));
    environmentRequire(m.manifestVersion === 1, "unsupported-version", "Unsupported manifestVersion", "$.manifestVersion");
    environmentExact(m, ["manifestVersion", "kind", "environmentId", "producer", "roles", "writableState", "members"]);
    environmentRequire(m.kind === "gglab.authoring-environment", "invalid-shape", "Unknown Environment kind", "$.kind");
    const p = environmentExact(m.producer, ["publisherVersion", "publisherSha256", "sourceRevision", "sourceDirty", "deployment"], "$.producer");
    environmentRequire(p.publisherVersion === "1.0.0" && typeof p.sourceDirty === "boolean" && typeof p.sourceRevision === "string" && /^[0-9a-f]{40}$/.test(p.sourceRevision) && isEnvironmentHash(p.publisherSha256), "invalid-shape", "Invalid producer provenance", "$.producer");
    environmentLocator(p.deployment, "$.producer.deployment");
    environmentRequire(environmentCanonical(m.roles) === environmentCanonical(ENVIRONMENT_ROLES) && environmentCanonical(m.writableState) === environmentCanonical({ root: "external", roles: ENVIRONMENT_STATE_ROLES }), "invalid-role", "Unsupported role layout", "$.roles");
    environmentRequire(Array.isArray(m.members) && m.members.length > 0 && m.members.length <= 20000, "invalid-shape", "Invalid members", "$.members");
    const names = new Set<string>(); let prior = "";
    m.members.forEach((raw: unknown, index: number) => {
        const path = `$.members[${index}]`;
        const member = environmentExact(raw, ["path", "size", "sha256"], path);
        const name = environmentLocator(member.path, `${path}.path`);
        environmentRequire(name.startsWith("payload/"), "invalid-path", "Member outside payload", path);
        environmentRequire(!names.has(name.toLowerCase()), "path-conflict", "Duplicate member", path);
        environmentRequire(name > prior, "invalid-shape", "Members must be ASCII path sorted", path);
        names.add(name.toLowerCase()); prior = name;
        environmentRequire(typeof member.size === "number" && Number.isSafeInteger(member.size) && member.size >= 0 && isEnvironmentHash(member.sha256), "invalid-member", "Invalid size or digest", path);
    });
    for (const name of names) {
        const parts = name.split("/"); parts.pop();
        while (parts.length) { environmentRequire(!names.has(parts.join("/")), "path-conflict", "File/directory conflict", name); parts.pop(); }
    }
    const directories = new Set(["shaderSources", "assets", "baseArtifacts", "vulkanLayers"]);
    for (const [role, path] of Object.entries(ENVIRONMENT_ROLES)) {
        environmentRequire(names.has(path.toLowerCase()) || (directories.has(role) && [...names].some(n => n.startsWith(path.toLowerCase() + "/"))), "missing-member", "Missing role member", path);
    }
    for (const name of ["payload/dxcompiler.dll", "payload/dxil.dll", "payload/vulkanlayers/vklayer_khronos_validation.dll", "payload/vulkanlayers/vklayer_khronos_validation.json", ...["gglab-dx12", "gglab-vulkan13"].map(t => `payload/baseartifacts/active/${t}/program-registry.ggsh.active`)]) {
        environmentRequire(names.has(name), "missing-member", "Missing required member", name);
    }
    environmentRequire(m.environmentId === environmentIdentity(m, hash), "identity-mismatch", "EnvironmentId does not match canonical manifest", "$.environmentId");
    return m as unknown as EnvironmentManifest;
}
export function isEnvironmentHash(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
export function environmentDiagnostic(error: unknown): EnvironmentDiagnostic {
    return error instanceof EnvironmentContractError ? error.diagnostic : { code: "io-error", severity: "error", message: error instanceof Error ? error.message : "Environment operation failed", dataPath: "$" };
}
