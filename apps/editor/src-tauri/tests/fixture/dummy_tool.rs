//! A trivial dummy shader toolchain executable, compiled by the host
//! tests (a plain `rustc` invocation over this file). It is the test
//! stand-in for `gglab-shaderc` at the boundary's exit criteria: a fixed
//! program whose bytes and exit behavior the tests can predict exactly.
//!
//! The dummy deliberately emits RAW BYTES and a fixed exit code — it is
//! NOT the machine-protocol tool: it does not speak JSON, it does not
//! read options, and the host tests never interpret its output as
//! protocol (no readiness logic, no document reading, no status
//! vocabulary). What the tests assert is exactly the settlement surface:
//! the bytes, the order of arguments, the exit code, and the end
//! states.
//!
//! Modes (first argument):
//!
//! - `describe` — emit fixed bytes on both streams; if the executable's
//!   own file name contains `sleep`, first sleep for a long time (the
//!   timeout / cancel tests point the candidate at that copy).
//! - `compile`  — dump the complete argument list (mode + everything
//!   after it, joined with the unit separator U+0001) so the host tests
//!   can assert the service's invocation serialization structurally,
//!   then exit with a fixed code that is NOT the tool's vocabulary.
//! - anything else — exit quietly.

use std::io::Write;

fn main() {
    let mut args = std::env::args();
    let self_path = args.next().unwrap_or_default();
    let mode = args.next().unwrap_or_default();
    let rest: Vec<String> = args.collect();
    // A slow copy of the same program: its identity is file NAME, so the
    // service (which spawns the candidate's path) cannot tell them apart
    // except by where the binary lives — exactly what a candidate IS.
    let slow = std::path::Path::new(&self_path)
        .file_name()
        .map(|name| name.to_string_lossy().contains("sleep"))
        .unwrap_or(false);

    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();

    match mode.as_str() {
        "describe" => {
            if slow {
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
            let _ = stdout.write_all(b"DESCRIPT-BYTES\n");
            let _ = stderr.write_all(b"DESCRIPT-ERR\n");
        }
        "compile" => {
            // The complete structural argument list, in order.
            let mut all = vec![mode.clone()];
            all.extend(rest);
            let joined = all.join("\u{1}");
            let _ = stdout.write_all(joined.as_bytes());
            let _ = stderr.write_all(b"COMPILE-ERR-BYTES\n");
            std::process::exit(4);
        }
        _ => {}
    }
}
