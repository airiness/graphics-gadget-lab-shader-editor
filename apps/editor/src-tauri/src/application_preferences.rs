//! Host-owned semantic dialog history. Stored paths are navigation hints, not capabilities.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const LIMIT: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum DialogKind { Workspace, Graph, EnvironmentSource, PublishedEnvironment, WritableState, DescriptorOverride, ToolExecutable, BuildOutput }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Preferences {
    preferences_version: u32,
    directories: BTreeMap<DialogKind, PathBuf>,
    #[serde(default)]
    layout: Option<LayoutPreferences>,
}
impl Default for Preferences {
    fn default() -> Self { Self { preferences_version: 1, directories: BTreeMap::new(), layout: None } }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayoutPreferences {
    pub library_open: bool,
    pub inspector_open: bool,
    pub bottom_panel_open: bool,
    pub bottom_panel_height: u16,
    pub bottom_panel_tab: BottomPanelTab,
    pub sidebar_panel: SidebarPanel,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BottomPanelTab { Output, Build, Preview, Problems }
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SidebarPanel { Explorer, Nodes }
impl LayoutPreferences {
    fn validate(&self) -> Result<(), String> {
        if !(96..=480).contains(&self.bottom_panel_height) { return Err("Bottom panel height must be between 96 and 480".into()); }
        Ok(())
    }
}

pub struct PreferencesStore { root: PathBuf }
impl PreferencesStore {
    pub fn new(root: PathBuf) -> Self { Self { root } }
    fn path(&self) -> PathBuf { self.root.join("application-preferences.json") }
    fn read(&self) -> Result<Preferences, String> {
        let file = match File::open(self.path()) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Preferences::default()),
            Err(e) => return Err(e.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT { return Err("Application preferences exceed the size limit".into()); }
        let data: Preferences = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        if data.preferences_version != 1 { return Err("Unsupported application preferences version".into()); }
        if data.directories.values().any(|path| !path.is_absolute()) {
            return Err("Application preference directories must be absolute".into());
        }
        if let Some(layout) = &data.layout { layout.validate()?; }
        Ok(data)
    }
    pub fn directory(&self, kind: DialogKind) -> Result<Option<PathBuf>, String> {
        Ok(self.read()?.directories.get(&kind).filter(|path| path.is_dir()).cloned())
    }
    /// Called only with a host dialog selection, never a WebView-supplied path.
    pub fn remember(&self, kind: DialogKind, directory: &Path) -> Result<(), String> {
        let directory = fs::canonicalize(directory).map_err(|e| e.to_string())?;
        if !directory.is_dir() { return Err("Remembered selection is not a directory".into()); }
        self.update(|data| { data.directories.insert(kind, directory); })
    }
    pub fn layout(&self) -> Result<Option<LayoutPreferences>, String> { Ok(self.read()?.layout) }
    pub fn save_layout(&self, layout: LayoutPreferences) -> Result<(), String> {
        layout.validate()?;
        self.update(|data| { data.layout = Some(layout); })
    }
    fn update(&self, change: impl FnOnce(&mut Preferences)) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        // OS-released lock: a crash cannot leave a permanent busy marker. Read under
        // the lock so concurrent windows preserve each other's semantic histories.
        let lock = OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(self.root.join("application-preferences.lock")).map_err(|e| e.to_string())?;
        lock.try_lock().map_err(|e| format!("Application preferences are busy: {e}"))?;
        let mut data = self.read()?;
        change(&mut data);
        let bytes = serde_json::to_vec_pretty(&data).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT { return Err("Application preferences exceed the size limit".into()); }
        let staging = self.root.join(format!(".preferences-{}-{}.tmp", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let mut created = false;
        let result = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).open(&staging).map_err(|e| e.to_string())?;
            created = true;
            file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|e| e.to_string())?;
            drop(file);
            replace(&staging, &self.path())
        })();
        if result.is_err() && created { let _ = fs::remove_file(&staging); }
        result
    }
}

#[cfg(windows)]
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(windows))]
fn replace(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("gglab-preferences-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn store(&self) -> PreferencesStore { PreferencesStore::new(self.0.join("prefs")) }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn layout_round_trips_without_erasing_dialog_history() {
        let f = Fixture::new(); f.store().remember(DialogKind::Workspace, &f.0).unwrap();
        let layout = LayoutPreferences { library_open: false, inspector_open: true, bottom_panel_open: true,
            bottom_panel_height: 280, bottom_panel_tab: BottomPanelTab::Problems, sidebar_panel: SidebarPanel::Explorer };
        f.store().save_layout(layout.clone()).unwrap();
        f.store().remember(DialogKind::Graph, &f.0).unwrap();
        assert_eq!(f.store().layout().unwrap(), Some(layout.clone()));
        assert!(f.store().directory(DialogKind::Workspace).unwrap().is_some());
        let bytes = fs::read(f.store().path()).unwrap();
        let mut invalid = layout; invalid.bottom_panel_height = 0;
        assert!(f.store().save_layout(invalid).is_err());
        assert_eq!(fs::read(f.store().path()).unwrap(), bytes);
        assert!(serde_json::from_str::<LayoutPreferences>(r#"{"current":true}"#).is_err());
    }
    #[test]
    fn histories_are_independent_and_survive_restart() {
        let f = Fixture::new(); let a = f.0.join("graphs"); let b = f.0.join("source");
        fs::create_dir(&a).unwrap(); fs::create_dir(&b).unwrap();
        assert!(f.store().directory(DialogKind::Graph).unwrap().is_none());
        f.store().remember(DialogKind::Graph, &a).unwrap();
        f.store().remember(DialogKind::EnvironmentSource, &b).unwrap();
        assert_eq!(f.store().directory(DialogKind::Graph).unwrap(), Some(fs::canonicalize(a).unwrap()));
        assert_eq!(f.store().directory(DialogKind::EnvironmentSource).unwrap(), Some(fs::canonicalize(b).unwrap()));
        assert!(f.store().directory(DialogKind::Workspace).unwrap().is_none());
    }
    #[test]
    fn unknown_versions_and_corrupt_data_are_preserved() {
        let f = Fixture::new(); fs::create_dir_all(f.store().root).unwrap();
        for bytes in [r#"{"preferencesVersion":2,"directories":{}}"#, "not json", r#"{"preferencesVersion":1,"directories":{},"current":true}"#] {
            fs::write(f.store().path(), bytes).unwrap();
            assert!(f.store().remember(DialogKind::Workspace, &f.0).is_err());
            assert_eq!(fs::read_to_string(f.store().path()).unwrap(), bytes);
        }
    }
    #[test]
    fn vanished_directories_are_not_restored_and_busy_writes_preserve_state() {
        let f = Fixture::new(); let dir = f.0.join("workspace"); fs::create_dir(&dir).unwrap();
        f.store().remember(DialogKind::Workspace, &dir).unwrap();
        let lock = OpenOptions::new().read(true).write(true).open(f.store().root.join("application-preferences.lock")).unwrap();
        lock.try_lock().unwrap();
        assert!(f.store().remember(DialogKind::Graph, &f.0).is_err());
        drop(lock);
        fs::remove_dir(dir).unwrap();
        assert!(f.store().directory(DialogKind::Workspace).unwrap().is_none());
        f.store().remember(DialogKind::Graph, &f.0).unwrap();
    }
}
