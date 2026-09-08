use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Share {
    pub file_path: String,
    pub owner: String,
    pub shared_with: Vec<String>, // "*" indicates public to all users
}

#[derive(Clone)]
pub struct ShareRegistry {
    data_dir: PathBuf,
    registry_path: PathBuf,
    shares: Arc<RwLock<HashMap<String, Share>>>,
}

impl ShareRegistry {
    fn normalize_username(username: &str) -> String {
        username.trim().to_lowercase()
    }

    pub fn new(data_dir: &str) -> Self {
        let data_dir = PathBuf::from(data_dir);
        let registry_path = data_dir.join("shares.json");
        let mut shares_map = HashMap::new();

        if registry_path.exists() {
            match fs::read_to_string(&registry_path) {
                Ok(content) => {
                    match serde_json::from_str::<Vec<Share>>(&content) {
                        Ok(list) => {
                            info!("Loaded {} shares from registry", list.len());
                            for share in list {
                                shares_map.insert(share.file_path.clone(), share);
                            }
                        }
                        Err(e) => {
                            warn!("Failed to parse shares.json: {}. Using empty registry.", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to read shares.json: {}. Using empty registry.", e);
                }
            }
        }

        Self {
            data_dir,
            registry_path,
            shares: Arc::new(RwLock::new(shares_map)),
        }
    }

    /// Persists current shares to shares.json
    fn save(&self) -> Result<(), String> {
        let shares_guard = self.shares.read().unwrap();
        let list: Vec<Share> = shares_guard.values().cloned().collect();
        let content = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("Failed to serialize shares: {}", e))?;

        if let Some(parent) = self.registry_path.parent() {
            if !parent.exists() {
                let _ = fs::create_dir_all(parent);
            }
        }

        fs::write(&self.registry_path, content)
            .map_err(|e| format!("Failed to write shares.json: {}", e))?;
        Ok(())
    }

    /// Configures sharing for a file.
    ///
    /// This replaces the previous share list for the file so callers can reliably
    /// update access from one set of users to another.
    pub fn add_share(&self, owner: &str, file_path: &str, shared_with: Vec<String>) -> Result<(), String> {
        let path_str = Path::new(file_path).to_string_lossy().to_string();
        let normalized_owner = Self::normalize_username(owner);

        let normalized_users: Vec<String> = shared_with
            .into_iter()
            .map(|user| Self::normalize_username(&user))
            .filter(|user| !user.is_empty())
            .collect();

        let final_shared_with = if normalized_users.iter().any(|user| user == "*") {
            vec!["*".to_string()]
        } else {
            let mut deduped = Vec::new();
            for user in normalized_users {
                if !deduped.contains(&user) {
                    deduped.push(user);
                }
            }
            deduped
        };

        {
            let mut shares_guard = self.shares.write().unwrap();

            if let Some(existing) = shares_guard.get_mut(&path_str) {
                if Self::normalize_username(&existing.owner) != normalized_owner {
                    return Err("Only the owner of a file can manage its sharing permissions".to_string());
                }
                existing.shared_with = final_shared_with;
            } else {
                shares_guard.insert(
                    path_str.clone(),
                    Share {
                        file_path: path_str,
                        owner: normalized_owner.clone(),
                        shared_with: final_shared_with,
                    },
                );
            }
        }

        self.save()?;
        info!("Updated sharing permissions for {}", file_path);
        Ok(())
    }

    /// Revokes file sharing access from a user (or all if user_to_remove is "*")
    pub fn remove_share(&self, owner: &str, file_path: &str, user_to_remove: &str) -> Result<(), String> {
        let path_str = Path::new(file_path).to_string_lossy().to_string();
        let normalized_owner = Self::normalize_username(owner);
        let normalized_user_to_remove = Self::normalize_username(user_to_remove);
        let mut remove_completely = false;

        {
            let mut shares_guard = self.shares.write().unwrap();
            if let Some(share) = shares_guard.get_mut(&path_str) {
                if Self::normalize_username(&share.owner) != normalized_owner {
                    return Err("Only the owner of a file can manage its sharing permissions".to_string());
                }

                if normalized_user_to_remove == "*" {
                    // Remove all sharing
                    remove_completely = true;
                } else {
                    // Retain others
                    share.shared_with.retain(|u| Self::normalize_username(u) != normalized_user_to_remove);
                    if share.shared_with.is_empty() {
                        remove_completely = true;
                    }
                }
            } else {
                return Err("No sharing config exists for this file".to_string());
            }

            if remove_completely {
                shares_guard.remove(&path_str);
            }
        }

        self.save()?;
        info!("Revoked sharing access from '{}' for {}", user_to_remove, file_path);
        Ok(())
    }

    /// Verifies if a user has access to a file
    pub fn check_access(&self, user: &str, file_path: &str) -> bool {
        let normalized_user = Self::normalize_username(user);
        let path_str = Path::new(file_path).to_string_lossy().to_string();

        let shares_guard = self.shares.read().unwrap();
        if let Some(share) = shares_guard.get(&path_str) {
            if Self::normalize_username(&share.owner) == normalized_user {
                return true;
            }
            if share.shared_with.iter().any(|entry| Self::normalize_username(entry) == "*") {
                return true;
            }
            if share.shared_with.iter().any(|entry| Self::normalize_username(entry) == normalized_user) {
                return true;
            }
            false
        } else {
            // Use path components rather than substring matching, and resolve symlinks
            // before granting access to a private workspace.
            let path = Path::new(file_path);
            let Ok(canonical_path) = fs::canonicalize(path) else { return false; };
            let user_roots = [
                self.data_dir.join(&normalized_user),
                self.data_dir.join("users").join(&normalized_user),
            ];
            user_roots.iter().any(|root| {
                fs::canonicalize(root)
                    .map(|canonical_root| canonical_path.starts_with(canonical_root))
                    .unwrap_or(false)
            })
        }
    }

    pub fn is_owner(&self, user: &str, file_path: &str, data_dir: &str) -> bool {
        let normalized_user = Self::normalize_username(user);
        let path_str = Path::new(file_path).to_string_lossy().to_string();

        if let Some(share) = self.shares.read().unwrap().get(&path_str) {
            return Self::normalize_username(&share.owner) == normalized_user;
        }

        let Ok(canonical_path) = fs::canonicalize(file_path) else { return false; };
        [
            Path::new(data_dir).join(&normalized_user),
            Path::new(data_dir).join("users").join(&normalized_user),
        ]
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| canonical_path.starts_with(root))
    }

    /// Returns list of usernames that are allowed to see the file (besides the owner)
    pub fn get_allowed_users(&self, file_path: &str) -> Vec<String> {
        let path_str = Path::new(file_path).to_string_lossy().to_string();
        let shares_guard = self.shares.read().unwrap();
        if let Some(share) = shares_guard.get(&path_str) {
            share.shared_with.iter().map(|user| Self::normalize_username(user)).collect()
        } else {
            Vec::new()
        }
    }

    /// Lists files shared by a user
    pub fn get_shares_by_owner(&self, owner: &str) -> Vec<Share> {
        let normalized_owner = Self::normalize_username(owner);
        let shares_guard = self.shares.read().unwrap();
        shares_guard
            .values()
            .filter(|s| Self::normalize_username(&s.owner) == normalized_owner)
            .cloned()
            .collect()
    }

    /// Lists files shared with a user
    pub fn get_shares_for_user(&self, user: &str) -> Vec<Share> {
        let normalized_user = Self::normalize_username(user);
        let shares_guard = self.shares.read().unwrap();
        shares_guard
            .values()
            .filter(|s| {
                s.shared_with.iter().any(|entry| Self::normalize_username(entry) == normalized_user)
                    || s.shared_with.iter().any(|entry| Self::normalize_username(entry) == "*")
            })
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_sharing_registry_flow() {
        let dir = tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        let registry = ShareRegistry::new(data_dir);

        let file_path = dir.path().join("users/alice/photo.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"photo").unwrap();
        let file = file_path.to_str().unwrap();

        // Access check by default (private)
        assert!(registry.check_access("alice", file));
        assert!(!registry.check_access("bob", file));
        assert!(!registry.check_access("alice", "/tmp/alice/secret.jpg"));

        // Share with Bob
        registry.add_share("alice", file, vec!["bob".to_string()]).unwrap();
        assert!(registry.check_access("bob", file));
        assert!(!registry.check_access("charlie", file));

        // Get allowed users
        assert_eq!(registry.get_allowed_users(file), vec!["bob".to_string()]);

        // Revoke Bob's access
        registry.remove_share("alice", file, "bob").unwrap();
        assert!(!registry.check_access("bob", file));
    }

    #[test]
    fn test_sharing_registry_normalizes_user_names() {
        let dir = tempdir().unwrap();
        let registry = ShareRegistry::new(dir.path().to_str().unwrap());
        let file_path = dir.path().join("users/Alice/Photos/vacation.jpg");
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, b"photo").unwrap();
        let file = file_path.to_str().unwrap();

        registry.add_share("Alice", file, vec!["Bob".to_string()]).unwrap();

        assert!(registry.check_access("bob", file));
        assert!(!registry.check_access("charlie", file));
        assert_eq!(registry.get_allowed_users(file), vec!["bob".to_string()]);
    }
}
