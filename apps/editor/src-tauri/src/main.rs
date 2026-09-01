// GGLab Shader Graph Editor — desktop entry point.
//
// All behavior lives in the crate library (src/lib.rs): the thin shell
// builder (the two official plugins — dialog and scoped fs — the access
// model) plus the ShaderToolService commands (the host boundary of the
// shader toolchain client). The entry function is a single hop.

// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gglab_shader_graph_editor::run();
}
