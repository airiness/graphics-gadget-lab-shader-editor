//! Visible-process stand-in for the attached Preview Runtime host tests. It
//! records its exact argv and working directory, then remains alive until the
//! service stops it.

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cwd = std::env::current_dir().unwrap();
    let record = format!("{}\n{}", args.join("\u{1}"), cwd.to_string_lossy());
    std::fs::write(cwd.join("preview-runtime-launch.txt"), record).unwrap();
    loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}
