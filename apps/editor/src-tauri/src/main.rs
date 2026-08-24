// GGLab Shader Graph Editor — desktop shell.
//
// The shell is a window plus two official plugins — and owns NO custom
// commands: the native surface is exactly
//
//   tauri-plugin-dialog : native open/save file dialogs; on a user pick
//                         the chosen path is added to the filesystem
//                         scope (the plugin does this itself);
//   tauri-plugin-fs     : scoped UTF-8 file access (readTextFile /
//                         writeTextFile, gated by that fs scope).
//
// Access model (why the official plugins instead of hand-written path
// commands): file access can only ever touch paths the user explicitly
// chose in a native dialog. No arbitrary-path read/write command exists
// in this build.
//
// The shell still knows nothing about shader graphs, node types, profile
// versions, or retained fields: parsing/serialization is
// shader-graph-core (frontend-side), and document/session state is the
// app's.

// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running the GGLab Shader Graph Editor desktop shell");
}
