"""Read-only producer qualification against the committed Editor baseline.

A nonzero result is a qualification failure, not an expected-success unit test.
All materialization is confined to a newly allocated temporary directory.
"""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
EDITOR = Path(__file__).resolve().parents[1]
BASELINE = json.loads((EDITOR / "tests/environment-producer-baseline.json").read_text())
ROOT = Path(os.environ.get("GGLAB_ENVIRONMENT_SOURCE", str(EDITOR.parent / "GraphicsGadgetLab"))).resolve()


def git(*args):
    return subprocess.check_output(["git", "-c", "safe.directory=" + ROOT.as_posix(), "-C", str(ROOT), *args], text=True).strip()


def main():
    assert os.name == "nt", "Windows filesystem qualification required"
    assert git("rev-parse", "HEAD") == BASELINE["producerRevision"], "Wrong producer revision"
    assert not git("status", "--porcelain", "--untracked-files=no"), "Dirty producer"
    spec = importlib.util.spec_from_file_location("producer", ROOT / "Scripts/Environment/publish_environment.py")
    producer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(producer)
    report = {"producerRevision": BASELINE["producerRevision"], "cases": []}
    with tempfile.TemporaryDirectory(prefix="gglab-alias-qualification-") as temporary:
        staging = Path(temporary) / ".staging-long-review-name"
        staging.mkdir()
        manifest = json.loads((ROOT / "Tests/Environment/fixtures/valid.json").read_text())
        for member in manifest["members"]:
            target = staging / member["path"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"synthetic fixture; not executable\n")
        (staging / "environment.json").write_text(json.dumps(manifest))
        buffer = ctypes.create_unicode_buffer(32768)
        count = ctypes.windll.kernel32.GetShortPathNameW(str(staging), buffer, len(buffer))
        assert 0 < count < len(buffer), "Short-name lookup failed"
        short = Path(buffer.value)
        assert short.samefile(staging), "Alias must name the same filesystem identity"
        report["distinctShortAlias"] = short.name.lower() != staging.name.lower()
        aliases = [("long", staging), ("upper", staging.with_name(staging.name.upper()))]
        if report["distinctShortAlias"]:
            aliases.append(("short", short))
        else:
            report["shortAliasStatus"] = "skipped-no-distinct-alias"
        for label, path in aliases:
            try:
                producer.verify(path)
                actual = "accepted"
            except producer.ContractError as error:
                actual = error.code
            report["cases"].append({"alias": label, "actual": actual, "expected": "incomplete-publication"})
        final = staging.with_name("final-environment")
        staging.rename(final)
        producer.verify(final)
        report["finalizedControl"] = "accepted"
    report["passed"] = all(case["actual"] == case["expected"] for case in report["cases"]) if report["distinctShortAlias"] else None
    print(json.dumps(report, indent=2))
    return 77 if report["passed"] is None else 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
