use bcrypt::{hash, DEFAULT_COST};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{warn};
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
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Deserialize)]
struct StoredSession {
    username: String,
    token_hash: Option<String>,
    token: Option<String>,
    created_at: String,
    expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResponse {
    pub user: String,
    pub token: String,
}

#[derive(Clone)]
pub struct AccountManager {
    data_dir: PathBuf,
    registry_path: PathBuf,
    sessions_path: PathBuf,
    accounts: Arc<RwLock<HashMap<String, Account>>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
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
                    Err(e) => warn!("Failed to parse accounts.json: {}. Using empty account registry.", e),
                },
                Err(e) => warn!("Failed to read accounts.json: {}. Using empty account registry.", e),
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
                                created_at: stored.created_at,
                                expires_at: stored.expires_at,
                            };
                            sessions.insert(token_hash, session);
                        }
                    }
                    Err(e) => warn!("Failed to parse sessions.json: {}. Using empty session registry.", e),
                },
                Err(e) => warn!("Failed to read sessions.json: {}. Using empty session registry.", e),
            }
        }

        let manager = Self {
            data_dir: data_root.to_path_buf(),
            registry_path,
            sessions_path,
            accounts: Arc::new(RwLock::new(accounts)),
            sessions: Arc::new(RwLock::new(sessions)),
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

    fn hash_password(password: &str) -> Result<String, String> {
        hash(password, DEFAULT_COST).map_err(|e| format!("Failed to hash password: {}", e))
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

    pub fn create_cloud_session(&self, username: &str) -> Result<LoginResponse, String> {
        let normalized = Self::normalize_username(username);
        {
            let mut accounts_guard = self.accounts.write().unwrap();
            if !accounts_guard.contains_key(&normalized) {
                let account = Account {
                    username: normalized.clone(),
                    password_hash: Self::hash_password(&Uuid::new_v4().to_string())?,
                    display_name: None,
                    role: "user".to_string(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                };
                accounts_guard.insert(normalized.clone(), account);
            }
        }
        self.ensure_user_workspace(&normalized)?;
        self.save_accounts()?;

        let token = Uuid::new_v4().to_string();
        let session = Session {
            username: normalized.clone(),
            token_hash: Self::hash_token(&token),
            created_at: chrono::Utc::now().to_rfc3339(),
            expires_at: (chrono::Utc::now() + chrono::Duration::minutes(15)).to_rfc3339(),
        };
        {
            let mut sessions_guard = self.sessions.write().unwrap();
            sessions_guard.insert(session.token_hash.clone(), session);
        }
        self.save_sessions()?;
        Ok(LoginResponse { user: normalized, token })
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
        let user = sessions_guard.get(&token_hash).map(|session| session.username.clone());
        drop(sessions_guard);

        let _ = self.save_sessions();
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

