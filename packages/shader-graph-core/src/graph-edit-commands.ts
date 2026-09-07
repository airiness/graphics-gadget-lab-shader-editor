/** Frontend-neutral edit vocabulary and strict request reader. */
import { DiagnosticCode, type ParseResult, type ShaderGraphDiagnostic } from "./diagnostics.js";
import { isGraphType, type GraphType } from "./graph-types.js";

export type ConstantValue = number | readonly number[];
export interface GraphEditEndpoint { readonly nodeId: string; readonly portId: string }
export type GraphEditCommand =
    | { readonly kind: "add-node"; readonly nodeType: string; readonly nodeId?: string; readonly parameterId?: string }
    | { readonly kind: "remove-node"; readonly nodeId: string }
    | { readonly kind: "set-constant-value"; readonly nodeId: string; readonly value: ConstantValue }
    | { readonly kind: "add-parameter"; readonly name: string; readonly class: string; readonly valueType: GraphType; readonly parameterId?: string; readonly nodeId?: string }
    | { readonly kind: "rename-parameter"; readonly parameterId: string; readonly name: string }
    | { readonly kind: "add-connection"; readonly from: GraphEditEndpoint; readonly to: GraphEditEndpoint; readonly connectionId?: string }
    | { readonly kind: "remove-connection"; readonly connectionId: string }
    | { readonly kind: "disconnect-port"; readonly nodeId: string; readonly portId: string; readonly side: "input" | "output" }
    | { readonly kind: "reconnect-connection"; readonly connectionId: string; readonly nodeId: string; readonly portId: string; readonly side: "from" | "to" }
    | { readonly kind: "set-profile"; readonly profile: string; readonly profileVersion: number };

type FieldKind = "string" | "constant" | "graph-type" | "endpoint" | "port-side" | "connection-side" | "positive-integer";
interface CommandShape { readonly required: Readonly<Record<string, FieldKind>>; readonly optional?: readonly string[] }

/** The machine frontend serializes this core-owned vocabulary, never a copy. */
export const graphEditCommandCatalog = {
    "add-node": { required: { nodeType: "string" }, optional: ["nodeId", "parameterId"] },
    "remove-node": { required: { nodeId: "string" } },
    "set-constant-value": { required: { nodeId: "string", value: "constant" } },
    "add-parameter": { required: { name: "string", class: "string", valueType: "graph-type" }, optional: ["parameterId", "nodeId"] },
    "rename-parameter": { required: { parameterId: "string", name: "string" } },
    "add-connection": { required: { from: "endpoint", to: "endpoint" }, optional: ["connectionId"] },
    "remove-connection": { required: { connectionId: "string" } },
    "disconnect-port": { required: { nodeId: "string", portId: "string", side: "port-side" } },
    "reconnect-connection": { required: { connectionId: "string", nodeId: "string", portId: "string", side: "connection-side" } },
    "set-profile": { required: { profile: "string", profileVersion: "positive-integer" } },
} as const satisfies Record<GraphEditCommand["kind"], CommandShape>;

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function string(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function matches(value: unknown, kind: FieldKind): boolean {
    switch (kind) {
        case "string": return string(value);
        case "graph-type": return string(value) && isGraphType(value);
        case "constant": return typeof value === "number" ? Number.isFinite(value) : Array.isArray(value) && value.length > 0 && Array.from(value).every((part) => typeof part === "number" && Number.isFinite(part));
        case "endpoint": return record(value) && Object.keys(value).length === 2 && string(value.nodeId) && string(value.portId);
        case "port-side": return value === "input" || value === "output";
        case "connection-side": return value === "from" || value === "to";
        case "positive-integer": return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    }
}

export function readGraphEditCommand(value: unknown, path = "$.command"): ParseResult<GraphEditCommand> {
    const fail = (dataPath: string, message: string): ShaderGraphDiagnostic => ({ code: DiagnosticCode.InvalidEditCommand, severity: "error", dataPath, message });
    if (!record(value) || !string(value.kind) || !Object.hasOwn(graphEditCommandCatalog, value.kind)) {
        return { ok: false, value: null, diagnostics: [fail(path, "Expected a supported graph edit command kind.")] };
    }
    const shape: CommandShape = graphEditCommandCatalog[value.kind as GraphEditCommand["kind"]];
    const diagnostics: ShaderGraphDiagnostic[] = [];
    for (const [key, kind] of Object.entries(shape.required)) {
        if (!matches(value[key], kind)) diagnostics.push(fail(`${path}.${key}`, `Expected ${kind} for "${key}".`));
    }
    for (const key of Object.keys(value)) {
        if (key === "kind" || Object.hasOwn(shape.required, key)) continue;
        if (!(shape.optional ?? []).includes(key)) diagnostics.push(fail(`${path}.${key}`, `Unknown edit field "${key}".`));
        else if (!string(value[key])) diagnostics.push(fail(`${path}.${key}`, `Expected a non-empty string for "${key}".`));
    }
    return diagnostics.length > 0 ? { ok: false, value: null, diagnostics } : { ok: true, value: value as unknown as GraphEditCommand, diagnostics: [] };
}

export function parseGraphEditCommands(text: string): ParseResult<readonly GraphEditCommand[]> {
    let value: unknown;
    try { value = JSON.parse(text); } catch {
        return { ok: false, value: null, diagnostics: [{ code: DiagnosticCode.InvalidJson, severity: "error", dataPath: "$", message: "Edit commands must be valid JSON." }] };
    }
    if (!Array.isArray(value)) return { ok: false, value: null, diagnostics: [{ code: DiagnosticCode.InvalidEditCommand, severity: "error", dataPath: "$", message: "Expected an array of edit commands." }] };
    const parsed = value.map((command, index) => readGraphEditCommand(command, `$[${index}]`));
    const diagnostics = parsed.flatMap((result) => result.diagnostics);
    return { ok: diagnostics.length === 0, value: diagnostics.length === 0 ? parsed.flatMap((result) => result.value === null ? [] : [result.value]) : null, diagnostics };
}
