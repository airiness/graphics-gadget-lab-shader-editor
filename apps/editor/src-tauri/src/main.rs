// GGLab Shader Graph Editor — desktop shell (native document I/O).
//
// This layer is a deliberately thin host. It owns exactly two things:
// the window, and native path + UTF-8 bytes. It knows nothing about
// shader graphs, node types, profile versions, or retained fields —
// parsing, serialization, and all document semantics stay in
// shader-graph-core (called from the frontend), and the frontend owns
// the session state. The native dialogs are likewise generic: they only
// choose a file path for the caller.

// Hide the console window on Windows release builds.
//
// Tauri 2 ACL note: app-level commands (`read_text_file` /
// `write_text_file`) do not take generated permissions by default — the
// capability file only grants the core defaults and the dialog plugin's
// open/save, which is the entire IPC surface this shell exposes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

/// Read a file as UTF-8 text. Thin host operation: path in, bytes out.
/// Invalid UTF-8 or IO failure is an explicit rejection (never a
/// silently lossy conversion) — interpreting the text is the frontend's
/// core reader's job.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    fs::read_to_string(PathBuf::from(&path)).map_err(|error| format!("Read failed at {path}: {error}"))
}

/// Write UTF-8 text to a file. Thin host operation: path + bytes in,
/// nothing out. What the bytes mean (a .shadergraph document, a profile
/// descriptor, ...) is defined entirely by the frontend and the core.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    fs::write(PathBuf::from(&path), contents).map_err(|error| format!("Write failed at {path}: {error}"))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            write_text_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running the GGLab Shader Graph Editor desktop shell");
}
