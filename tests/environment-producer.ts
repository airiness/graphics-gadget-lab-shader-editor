import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const environmentQualificationEnabled = process.env.GGLAB_ENVIRONMENT_QUALIFICATION === "1";
/** A different sibling checkout must never silently replace recorded evidence. */
export function environmentProducerFixtures(): string {
    if (!environmentQualificationEnabled) throw new Error("Set GGLAB_ENVIRONMENT_QUALIFICATION=1 to run pinned producer qualification");
    const baseline = JSON.parse(readFileSync(new URL("./environment-producer-baseline.json", import.meta.url), "utf8")) as { producerRevision: string };
    const root = resolve(process.env.GGLAB_ENVIRONMENT_SOURCE ?? fileURLToPath(new URL("../../GraphicsGadgetLab/", import.meta.url)));
    const git = (...args: string[]): string => execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, "-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
    if (git("rev-parse", "HEAD") !== baseline.producerRevision || git("status", "--porcelain", "--untracked-files=no") !== "") {
        throw new Error(`Environment evidence requires clean producer ${baseline.producerRevision}; select an isolated checkout with GGLAB_ENVIRONMENT_SOURCE`);
    }
    const fixtures = resolve(root, "Tests/Environment/fixtures");
    if (process.env.GGLAB_ENVIRONMENT_FIXTURES !== undefined && resolve(process.env.GGLAB_ENVIRONMENT_FIXTURES) !== fixtures) {
        throw new Error("Unversioned Environment fixture overrides cannot qualify this Editor revision");
    }
    return fixtures;
}
