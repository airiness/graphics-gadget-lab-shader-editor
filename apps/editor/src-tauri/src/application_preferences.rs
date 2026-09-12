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
    #[serde(default)]
    workspaces: Vec<WorkspaceResume>,
}
impl Default for Preferences {
    fn default() -> Self { Self { preferences_version: 1, directories: BTreeMap::new(), layout: None, workspaces: Vec::new() } }
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceResume {
    pub workspace_uri: String,
    pub document_uris: Vec<String>,
    pub active_uri: Option<String>,
    pub preview_uri: Option<String>,
    pub environment_id: Option<String>,
    pub build_target: String,
}
impl WorkspaceResume {
    pub fn validate(&self) -> Result<(), String> {
        if self.workspace_uri.is_empty() || self.workspace_uri.len() > 8192 || self.document_uris.len() > 32 ||
            self.document_uris.iter().any(|uri| uri.is_empty() || uri.len() > 8192) ||
            self.document_uris.iter().collect::<std::collections::HashSet<_>>().len() != self.document_uris.len() ||
            [&self.active_uri, &self.preview_uri].iter().any(|uri| uri.as_ref().is_some_and(|uri| !self.document_uris.contains(uri))) ||
            self.environment_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128) ||
            self.build_target.is_empty() || self.build_target.len() > 128 {
            return Err("Invalid Workspace resume intent".into());
        }
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
        if data.workspaces.len() > 10 || data.workspaces.iter().map(|item| &item.workspace_uri).collect::<std::collections::HashSet<_>>().len() != data.workspaces.len() { return Err("Too many saved Workspaces".into()); }
        for workspace in &data.workspaces { workspace.validate()?; }
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
    pub fn workspace(&self, uri: &str) -> Result<Option<WorkspaceResume>, String> {
        Ok(self.read()?.workspaces.into_iter().find(|item| item.workspace_uri == uri))
    }
    pub fn save_workspace(&self, intent: WorkspaceResume) -> Result<(), String> {
        intent.validate()?;
        self.update(|data| {
            data.workspaces.retain(|item| item.workspace_uri != intent.workspace_uri);
            data.workspaces.insert(0, intent);
            data.workspaces.truncate(10);
        })
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
    fn workspace_intent_survives_restart_without_native_evidence_or_history_loss() {
        let f = Fixture::new();
        f.store().remember(DialogKind::Workspace, &f.0).unwrap();
        let intent = WorkspaceResume { workspace_uri: "file:///workspace/".into(), document_uris: vec!["file:///workspace/a.shadergraph".into()],
            active_uri: Some("file:///workspace/a.shadergraph".into()), preview_uri: None, environment_id: Some("env".into()), build_target: "dx12".into() };
        f.store().save_workspace(intent.clone()).unwrap();
        assert_eq!(f.store().workspace(&intent.workspace_uri).unwrap(), Some(intent.clone()));
        assert!(f.store().directory(DialogKind::Workspace).unwrap().is_some());
        let previous = fs::read(f.store().path()).unwrap();
        let mut invalid = intent.clone(); invalid.preview_uri = Some("not-open".into());
        assert!(f.store().save_workspace(invalid).is_err());
        let mut duplicate = intent.clone(); duplicate.document_uris.push(duplicate.document_uris[0].clone());
        assert!(f.store().save_workspace(duplicate).is_err());
        assert_eq!(fs::read(f.store().path()).unwrap(), previous);
        let mut wire = serde_json::to_value(&intent).unwrap(); wire["current"] = true.into();
        assert!(serde_json::from_value::<WorkspaceResume>(wire).is_err());
        for index in 0..11 {
            let mut next = intent.clone(); next.workspace_uri = format!("file:///workspace-{index}/");
            f.store().save_workspace(next).unwrap();
        }
        assert_eq!(f.store().read().unwrap().workspaces.len(), 10);
        assert!(f.store().workspace(&intent.workspace_uri).unwrap().is_none());
    }
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
