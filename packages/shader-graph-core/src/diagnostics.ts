/**
 * Structured diagnostics shared by all core parse and semantic services.
 *
 * Diagnostics are structured data, never unstructured `string[]` output.
 * `code` is a stable machine-readable identifier; `message` is the
 * human-readable explanation; `dataPath` anchors the diagnostic to a
 * location in the parsed input using a dot path with `[index]` array
 * segments, where "$" is the input root.
 *
 * Later semantic services (type checking, validation, emission) produce
 * diagnostics on the same shape; their location authority is graph-local
 * node/parameter identity.
 */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface ShaderGraphDiagnostic {
    readonly code: string;
    readonly severity: DiagnosticSeverity;
    readonly message: string;
    readonly dataPath: string;
}

/**
 * Result of a core parse service.
 *
 * `ok` is true only if the parsed value is usable downstream. Warnings never
 * flip `ok`: they mark explicit degradation (for example an unknown but
 * retained node type). Errors always flip `ok`.
 *
 * `diagnostics` is in input encounter order, therefore deterministic for
 * identical input.
 */
export interface ParseResult<T> {
    readonly ok: boolean;
    readonly value: T | null;
    readonly diagnostics: readonly ShaderGraphDiagnostic[];
}

/** Stable diagnostic code vocabulary of the core. Never free-form text. */
export const DiagnosticCode = {
    InvalidJson: "INVALID_JSON",
    MissingRequiredField: "MISSING_REQUIRED_FIELD",
    UnexpectedType: "UNEXPECTED_TYPE",
    UnexpectedField: "UNEXPECTED_FIELD",
    InvalidStableId: "INVALID_STABLE_ID",
    DuplicateNodeId: "DUPLICATE_NODE_ID",
    DuplicateParameterId: "DUPLICATE_PARAMETER_ID",
    DuplicateConnectionId: "DUPLICATE_CONNECTION_ID",
    UnresolvedNodeReference: "UNRESOLVED_NODE_REFERENCE",
    UnknownNodeType: "UNKNOWN_NODE_TYPE",
    UnknownNodeVersion: "UNKNOWN_NODE_VERSION",
    UnsupportedSchemaVersion: "UNSUPPORTED_SCHEMA_VERSION",
    UnsupportedDescriptorVersion: "UNSUPPORTED_DESCRIPTOR_VERSION",
    UnsupportedLanguage: "UNSUPPORTED_LANGUAGE",
    UnknownPort: "UNKNOWN_PORT",
    MissingRequiredInput: "MISSING_REQUIRED_INPUT",
    TypeMismatch: "TYPE_MISMATCH",
    DuplicateConnection: "DUPLICATE_CONNECTION",
    InvalidConnection: "INVALID_CONNECTION",
    CycleDetected: "CYCLE_DETECTED",
    MissingOutput: "MISSING_OUTPUT",
    UnknownProfileFeature: "UNKNOWN_PROFILE_FEATURE",
} as const;

export type DiagnosticCodeValue = (typeof DiagnosticCode)[keyof typeof DiagnosticCode];
