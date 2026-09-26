use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::warn;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub username: String,
    pub display_name: Option<String>,
    pub password_hash: String,
    pub role: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub username: String,
    pub token_hash: String,
    /// Public identifier sent in the clear so the server can select a key before decrypting.
    #[serde(default)]
    pub key_id: String,
    /// The access token itself. Symmetric envelope crypto needs the real secret at both ends,
    /// so unlike a bearer-only design this file holds usable key material.
    #[serde(default)]
    pub secret: String,
    pub created_at: String,
    pub expires_at: String,
    #[serde(default)]
    pub replay_high: u64,
    #[serde(default)]
    pub replay_mask: u64,
}

#[derive(Deserialize)]
struct StoredSession {
    username: String,
    token_hash: Option<String>,
    token: Option<String>,
    #[serde(default)]
    key_id: Option<String>,
    #[serde(default)]
    secret: Option<String>,
    created_at: String,
    expires_at: String,
    #[serde(default)]
    replay_high: u64,
    #[serde(default)]
    replay_mask: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user: String,
    pub token: String,
    pub key_id: String,
    pub expires_at: String,
}

/// How long an access token issued by this instance stays valid. The same token is used for
/// LAN requests and for requests relayed through the cloud, so it outlives a single app session.
const SESSION_TTL_DAYS: i64 = 30;

const SESSION_PERSIST_INTERVAL_MS: i64 = 2_000;

#[derive(Clone)]
pub struct AccountManager {
    data_dir: PathBuf,
    registry_path: PathBuf,
    sessions_path: PathBuf,
    accounts: Arc<RwLock<HashMap<String, Account>>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    sessions_persisted_at: Arc<RwLock<i64>>,
}

impl AccountManager {
    pub fn new(data_dir: &str) -> Self {
        let data_root = Path::new(data_dir);
        if !data_root.exists() {
            let _ = fs::create_dir_all(data_root);
        }

        let registry_path = data_root.join("accounts.json");
        let sessions_path = data_root.join("sessions.json");
        let mut accounts = HashMap::new();

        if registry_path.exists() {
            match fs::read_to_string(&registry_path) {
                Ok(content) => match serde_json::from_str::<Vec<Account>>(&content) {
                    Ok(list) => {
                        for account in list {
                            accounts.insert(account.username.clone(), account);
                        }
                    }
                    Err(e) => warn!(
                        "Failed to parse accounts.json: {}. Using empty account registry.",
                        e
                    ),
                },
                Err(e) => warn!(
                    "Failed to read accounts.json: {}. Using empty account registry.",
                    e
                ),
            }
        }

        let mut sessions = HashMap::new();
        let mut migrated_plaintext_sessions = false;
        if sessions_path.exists() {
            match fs::read_to_string(&sessions_path) {
                Ok(content) => match serde_json::from_str::<Vec<StoredSession>>(&content) {
                    Ok(list) => {
                        for stored in list {
                            let token_hash = match (stored.token_hash, stored.token) {
                                (Some(token_hash), _) => token_hash,
                                (None, Some(token)) => {
                                    migrated_plaintext_sessions = true;
                                    Self::hash_token(&token)
                                }
                                (None, None) => continue,
                            };
                            let session = Session {
                                username: stored.username,
                                token_hash: token_hash.clone(),
                                key_id: stored.key_id.unwrap_or_default(),
                                secret: stored.secret.unwrap_or_default(),
                                created_at: stored.created_at,
                                expires_at: stored.expires_at,
                                // Requests accepted just before shutdown may not have been
                                // persisted, so skip past them rather than risk a replay.
                                replay_high: stored.replay_high + crate::secure::REPLAY_RESTART_MARGIN,
                                replay_mask: stored.replay_mask,
                            };
                            sessions.insert(token_hash, session);
                        }
                    }
                    Err(e) => warn!(
                        "Failed to parse sessions.json: {}. Using empty session registry.",
                        e
                    ),
                },
                Err(e) => warn!(
                    "Failed to read sessions.json: {}. Using empty session registry.",
                    e
                ),
            }
        }

        let manager = Self {
            data_dir: data_root.to_path_buf(),
            registry_path,
            sessions_path,
            accounts: Arc::new(RwLock::new(accounts)),
            sessions: Arc::new(RwLock::new(sessions)),
            sessions_persisted_at: Arc::new(RwLock::new(0)),
        };
        if migrated_plaintext_sessions {
            let _ = manager.save_sessions();
        }
        manager
    }

    fn save_accounts(&self) -> Result<(), String> {
        let accounts_guard = self.accounts.read().unwrap();
        let list: Vec<Account> = accounts_guard.values().cloned().collect();
        let content = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("Failed to serialize accounts: {}", e))?;

        if let Some(parent) = self.registry_path.parent() {
            if !parent.exists() {
                let _ = fs::create_dir_all(parent);
            }
        }

        fs::write(&self.registry_path, content)
            .map_err(|e| format!("Failed to write accounts.json: {}", e))?;
        Ok(())
    }

    fn save_sessions(&self) -> Result<(), String> {
        let sessions_guard = self.sessions.read().unwrap();
        let list: Vec<Session> = sessions_guard.values().cloned().collect();
        let content = serde_json::to_string_pretty(&list)
            .map_err(|e| format!("Failed to serialize sessions: {}", e))?;

        if let Some(parent) = self.sessions_path.parent() {
            if !parent.exists() {
                let _ = fs::create_dir_all(parent);
            }
        }

        fs::write(&self.sessions_path, content)
            .map_err(|e| format!("Failed to write sessions.json: {}", e))?;
        Ok(())
    }

    pub fn normalize_username(username: &str) -> String {
        username.trim().to_lowercase()
    }

    fn hash_token(token: &str) -> String {
        let digest = Sha256::digest(token.as_bytes());
        format!("{digest:x}")
    }

    fn ensure_user_workspace(&self, username: &str) -> Result<(), String> {
        let workspace_root = self.data_dir.join(username);
        for folder in ["Photos", "Documents", "Files", "Notes", "Contacts"] {
            let path = workspace_root.join(folder);
            if !path.exists() {
                fs::create_dir_all(&path)
                    .map_err(|e| format!("Failed to create workspace folder {:?}: {}", path, e))?;
            }
        }
        Ok(())
    }

    /// Issues an access token for a user whose password was verified by the cloud and asserted
    /// over the signed relay tunnel. The token this returns is the only credential that grants
    /// access to instance data, on the LAN and through the relay alike.
    pub fn create_federated_session(
        &self,
        username: &str,
        display_name: Option<&str>,
    ) -> Result<LoginResponse, String> {
        let normalized = Self::normalize_username(username);
        if normalized.is_empty() {
            return Err("A username is required to create a session".to_string());
        }
        {
            let mut accounts_guard = self.accounts.write().unwrap();
            let account = accounts_guard
                .entry(normalized.clone())
                .or_insert_with(|| Account {
                    username: normalized.clone(),
                    // Passwords are verified by the cloud, never here, so no usable local password exists.
                    password_hash: String::new(),
                    display_name: None,
                    role: "user".to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                });
            if let Some(label) = display_name
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                account.display_name = Some(label.to_string());
            }
        }
        self.ensure_user_workspace(&normalized)?;
        self.save_accounts()?;

        let token = Uuid::new_v4().to_string();
        let key_id = Uuid::new_v4().simple().to_string();
        let expires_at =
            (chrono::Utc::now() + chrono::Duration::days(SESSION_TTL_DAYS)).to_rfc3339();
        let session = Session {
            username: normalized.clone(),
            token_hash: Self::hash_token(&token),
            key_id: key_id.clone(),
            secret: token.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            expires_at: expires_at.clone(),
            replay_high: 0,
            replay_mask: 0,
        };
        {
            let mut sessions_guard = self.sessions.write().unwrap();
            sessions_guard.insert(session.token_hash.clone(), session);
        }
        self.save_sessions()?;
        Ok(LoginResponse {
            user: normalized,
            token,
            key_id,
            expires_at,
        })
    }

    /// Resolves the session behind an envelope's key id, returning the user and the secret the
    /// envelope keys are derived from.
    pub fn session_for_key_id(&self, key_id: &str) -> Option<(String, String)> {
        let sessions_guard = self.sessions.read().unwrap();
        let session = sessions_guard
            .values()
            .find(|session| !session.key_id.is_empty() && session.key_id == key_id)?;
        if let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(&session.expires_at) {
            if expires_at < chrono::Utc::now() {
                return None;
            }
        }
        if session.secret.is_empty() {
            return None;
        }
        Some((session.username.clone(), session.secret.clone()))
    }

    /// Accepts an envelope sequence number exactly once. On rejection returns the sequence
    /// number the client should resume from, which it needs after the server restarts.
    pub fn accept_sequence(&self, key_id: &str, seq: u64) -> Result<(), u64> {
        let mut sessions_guard = self.sessions.write().unwrap();
        let Some(session) = sessions_guard
            .values_mut()
            .find(|session| !session.key_id.is_empty() && session.key_id == key_id)
        else {
            return Err(0);
        };

        let mut window = crate::secure::ReplayWindow {
            high: session.replay_high,
            mask: session.replay_mask,
        };
        if !window.accept(seq) {
            return Err(session.replay_high + 1);
        }
        session.replay_high = window.high;
        session.replay_mask = window.mask;
        drop(sessions_guard);

        self.persist_sessions_debounced();
        Ok(())
    }

    /// The replay window changes on every request, so writes are coalesced instead of rewriting
    /// the whole session file each time. The restart margin covers whatever hasn't landed yet.
    fn persist_sessions_debounced(&self) {
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut last = self.sessions_persisted_at.write().unwrap();
            if now - *last < SESSION_PERSIST_INTERVAL_MS {
                return;
            }
            *last = now;
        }
        let _ = self.save_sessions();
    }

    /// Invalidates a single access token. Returns whether a matching session existed.
    pub fn revoke_token(&self, token: &str) -> bool {
        let token_hash = Self::hash_token(token);
        let removed = self.sessions.write().unwrap().remove(&token_hash).is_some();
        if removed {
            let _ = self.save_sessions();
        }
        removed
    }

    pub fn authenticate_token(&self, token: &str) -> Option<String> {
        let mut sessions_guard = self.sessions.write().unwrap();
        let now = chrono::Utc::now();
        let mut expired_tokens = Vec::new();

        for (session_token, session) in sessions_guard.iter() {
            if let Ok(expires_at) = chrono::DateTime::parse_from_rfc3339(&session.expires_at) {
                if expires_at < now {
                    expired_tokens.push(session_token.clone());
                }
            }
        }

        for expired_token in expired_tokens {
            sessions_guard.remove(&expired_token);
        }

        let token_hash = Self::hash_token(token);
        let user = sessions_guard
            .get(&token_hash)
            .map(|session| session.username.clone());
        drop(sessions_guard);

        self.persist_sessions_debounced();
        user
    }

    pub fn is_admin(&self, username: &str) -> bool {
        let normalized = Self::normalize_username(username);
        let accounts_guard = self.accounts.read().unwrap();
        accounts_guard
            .get(&normalized)
            .map(|account| account.role == "admin")
            .unwrap_or(false)
    }
}
