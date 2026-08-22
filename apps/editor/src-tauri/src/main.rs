// GGLab Shader Graph Editor — desktop shell.
//
// This is a thin host: it loads the existing React/Vite frontend into a
// native window and nothing more. It intentionally has no knowledge of
// ShaderGraph semantics, profile versions, descriptor compatibility, or
// HLSL emission, and it registers no commands or plugins. The frontend
// runs exactly as it does in the browser.

// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running the GGLab Shader Graph Editor desktop shell");
}
