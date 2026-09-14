//! One-use observation admission for registry commit. Semantic proof stays in the shared/frontend pipeline.
use crate::environment_io::{error, EnvironmentHostError as Error};
use crate::environment_storage::{
    DirectoryKind, DirectoryObservation, EnvironmentStorageService, RegistryStorage,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};

struct Pending {
    environment: String,
    state: String,
    environment_snapshot: Vec<u8>,
    state_snapshot: Vec<u8>,
    key: String,
    record: String,
}
#[derive(Default)]
pub struct RegistrationService {
    pending: Mutex<HashMap<String, Pending>>,
    sequence: AtomicU64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Admission {
    registration_id: String,
    environment: DirectoryObservation,
    state: DirectoryObservation,
}
#[derive(Serialize)]
pub struct Settlement {
    text: String,
    inserted: bool,
}
fn io(e: impl ToString) -> Error {
    error("io-error", e)
}
impl RegistrationService {
    pub fn prepare(
        &self,
        storage: &EnvironmentStorageService,
        environment: &str,
        state: &str,
    ) -> Result<Admission, Error> {
        let environment_root = storage.selected_path(environment, DirectoryKind::Environment)?;
        let state_root = storage.selected_path(state, DirectoryKind::State)?;
        if environment_root.starts_with(&state_root) || state_root.starts_with(&environment_root) {
            return Err(error("invalid-path", "Registration roots overlap"));
        }
        let environment_observation = storage.observe(environment)?;
        let state_observation = storage.observe(state)?;
        let raw = serde_json::to_value(&environment_observation).map_err(io)?;
        let manifest: serde_json::Value = serde_json::from_str(
            raw["metadataText"]
                .as_str()
                .ok_or_else(|| error("missing-member", "Missing manifest"))?,
        )
        .map_err(io)?;
        let identity = manifest["environmentId"]
            .as_str()
            .ok_or_else(|| error("identity-mismatch", "Missing Environment identity"))?;
        let key = identity
            .strip_prefix("sha256:")
            .filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
            })
            .ok_or_else(|| error("identity-mismatch", "Invalid Environment identity"))?
            .to_owned();
        let raw = serde_json::to_value(&state_observation).map_err(io)?;
        let binding: serde_json::Value = serde_json::from_str(
            raw["metadataText"]
                .as_str()
                .ok_or_else(|| error("missing-member", "Missing state binding"))?,
        )
        .map_err(io)?;
        if binding["environmentId"] != identity || binding["stateVersion"] != 1 {
            return Err(error("state-conflict", "State binding changed"));
        }
        let record=serde_json::json!({"registryVersion":1,"environmentId":identity,"environmentRoot":environment_root,"stateRoot":state_root}).to_string();
        let mut pending = self.pending.lock().map_err(io)?;
        if pending.len() >= 4 {
            return Err(error("host-busy", "Too many registration admissions"));
        }
        let registration_id = format!(
            "environment-registration:{}",
            self.sequence.fetch_add(1, Ordering::SeqCst) + 1
        );
        pending.insert(
            registration_id.clone(),
            Pending {
                environment: environment.into(),
                state: state.into(),
                environment_snapshot: serde_json::to_vec(&environment_observation).map_err(io)?,
                state_snapshot: serde_json::to_vec(&state_observation).map_err(io)?,
                key,
                record,
            },
        );
        Ok(Admission {
            registration_id,
            environment: environment_observation,
            state: state_observation,
        })
    }
    pub fn discard(&self, id: &str) -> Result<(), Error> {
        self.pending.lock().map_err(io)?.remove(id);
        Ok(())
    }
    pub fn commit(
        &self,
        storage: &EnvironmentStorageService,
        registry: &RegistryStorage,
        id: &str,
    ) -> Result<Settlement, Error> {
        // A rejected or interrupted commit cannot reuse a stale observation admission.
        let admission = self.pending.lock().map_err(io)?.remove(id).ok_or_else(|| {
            error(
                "invalid-handle",
                "Registration admission is absent or consumed",
            )
        })?;
        let environment = storage.observe(&admission.environment)?;
        let state = storage.observe(&admission.state)?;
        if serde_json::to_vec(&environment).map_err(io)? != admission.environment_snapshot
            || serde_json::to_vec(&state).map_err(io)? != admission.state_snapshot
        {
            return Err(error(
                "source-changed",
                "Registration observations changed before commit",
            ));
        }
        let (text, inserted) = registry.insert(&admission.key, &admission.record)?;
        Ok(Settlement { text, inserted })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn admission_is_one_use_and_rejects_changed_facts_without_registering() {
        let root = std::env::temp_dir().join(format!(
            "gglab-registration-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let temp = Temp(root);
        let environment = temp.0.join("environment");
        let state = temp.0.join("state");
        fs::create_dir(&environment).unwrap();
        fs::create_dir(&state).unwrap();
        // Synthetic metadata exercises host observation admission, never native compatibility.
        let identity = format!("sha256:{}", "a".repeat(64));
        fs::write(
            environment.join("environment.json"),
            serde_json::json!({"environmentId":identity}).to_string(),
        )
        .unwrap();
        fs::write(
            state.join("state.json"),
            serde_json::json!({"stateVersion":1,"environmentId":identity}).to_string(),
        )
        .unwrap();
        let storage = EnvironmentStorageService::default();
        let env = storage
            .select(&environment, DirectoryKind::Environment)
            .unwrap();
        let state_handle = storage.select(&state, DirectoryKind::State).unwrap();
        let service = RegistrationService::default();
        let registry = RegistryStorage::new(temp.0.join("registry")).unwrap();
        let prepare = || {
            service
                .prepare(&storage, &env.directory_id, &state_handle.directory_id)
                .unwrap()
                .registration_id
        };
        let first = prepare();
        fs::write(environment.join("added"), "changed").unwrap();
        assert_eq!(
            service
                .commit(&storage, &registry, &first)
                .err()
                .unwrap()
                .code,
            "source-changed"
        );
        assert_eq!(
            service
                .commit(&storage, &registry, &first)
                .err()
                .unwrap()
                .code,
            "invalid-handle"
        );
        let second = prepare();
        fs::write(state.join("state.json"), "{}").unwrap();
        assert_eq!(
            service
                .commit(&storage, &registry, &second)
                .err()
                .unwrap()
                .code,
            "source-changed"
        );
        assert!(!temp.0.join("registry").join("a".repeat(64)).exists());
        fs::write(
            state.join("state.json"),
            serde_json::json!({"stateVersion":1,"environmentId":identity}).to_string(),
        )
        .unwrap();
        let discarded = prepare();
        service.discard(&discarded).unwrap();
        assert_eq!(
            service
                .commit(&storage, &registry, &discarded)
                .err()
                .unwrap()
                .code,
            "invalid-handle"
        );
        let committed = service.commit(&storage, &registry, &prepare()).unwrap();
        assert!(committed.inserted);
        let duplicate = service.commit(&storage, &registry, &prepare()).unwrap();
        assert!(!duplicate.inserted);
        assert_eq!(duplicate.text, committed.text);
        let record: serde_json::Value = serde_json::from_str(&committed.text).unwrap();
        assert_eq!(record.as_object().unwrap().len(), 4);
    }
}
