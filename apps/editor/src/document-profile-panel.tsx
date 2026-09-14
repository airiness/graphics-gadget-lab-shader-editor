import { useState } from "react";
import type { GraphEditResult, ShaderGraphDocument, SurfaceProfileDescriptor } from "@gglab/shader-graph-core";
import { Button } from "@gglab/editor-ui";

/** A document authoring intent; the parent applies the core command and history. */
export function DocumentProfilePanel({ document, catalog, onApply }: {
    readonly document: ShaderGraphDocument;
    readonly catalog: readonly SurfaceProfileDescriptor[];
    readonly onApply: (descriptor: SurfaceProfileDescriptor) => GraphEditResult;
}) {
    const key = (id: string, version: number) => JSON.stringify([id, version]);
    const [requested, setRequested] = useState(key(document.profile, document.profileVersion));
    const [result, setResult] = useState<GraphEditResult | null>(null);
    const selected = catalog.find(d => key(d.profileId, d.profileVersion) === requested);
    return <section aria-label="Document profile choice">
        <p>Document profile: {document.profile} v{document.profileVersion}</p>
        <label>Requested profile
            <select className="gglab-native-select" value={requested} onChange={event => { setRequested(event.currentTarget.value); setResult(null); }}>
                {selected === undefined && <option value={requested}>Requested profile unavailable</option>}
                {catalog.map(d => <option key={key(d.profileId, d.profileVersion)} value={key(d.profileId, d.profileVersion)}>{d.profileId} v{d.profileVersion}</option>)}
            </select>
        </label>
        <p>Apply changes this document through core validation and can be undone. Choosing an Environment never upgrades its profile.</p>
        <Button disabled={selected === undefined} onClick={() => { if (selected !== undefined) setResult(onApply(selected)); }}>Apply document profile</Button>
        {catalog.length === 0 && <p>No admitted profile choices. Set up an Environment or load a loose development descriptor.</p>}
        {result !== null && <div role="status">
            {result.status === "refused" ? "Profile change refused." : result.status === "unchanged" ? "The document already requests this profile." : "Document profile changed."}
            {result.diagnostics.map((diagnostic, index) => <p key={index}>{diagnostic.code}: {diagnostic.message}</p>)}
        </div>}
    </section>;
}
