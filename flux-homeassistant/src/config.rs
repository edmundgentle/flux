use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub data_dir: String,
    pub scan_dirs: Vec<String>,
    pub instance_id: Option<String>,
    pub websocket_url: Option<String>,
    pub websocket_token: Option<String>,
    #[serde(default = "default_cloud_url")]
    pub cloud_url: String,
}

fn default_cloud_url() -> String {
    "https://flux-relay-fvnyy.ondigitalocean.app".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            data_dir: "/config/search_vision".to_string(),
            scan_dirs: vec!["/share".to_string(), "/media".to_string()],
            instance_id: None,
            websocket_url: None,
            websocket_token: None,
            cloud_url: default_cloud_url(),
        }
    }
}

pub struct ConfigManager {
    config_path: PathBuf,
    current_config: Arc<RwLock<AppConfig>>,
}

impl AppConfig {
    pub fn validate_bridge_settings(&self) -> Result<(), String> {
        let has_instance = self.instance_id.as_ref().is_some_and(|value| !value.trim().is_empty());
        let has_url = self.websocket_url.as_ref().is_some_and(|value| !value.trim().is_empty());
        let has_token = self.websocket_token.as_ref().is_some_and(|value| !value.trim().is_empty());

        let configured_count = [has_instance, has_url, has_token].iter().filter(|&&value| value).count();
        if configured_count == 0 {
            return Ok(());
        }

        if configured_count != 3 {
            return Err("Partial relay configuration detected: instance_id, websocket_url, and websocket_token must all be set together".to_string());
        }

        if let Some(url) = &self.websocket_url {
            if !url.starts_with("ws://") && !url.starts_with("wss://") {
                return Err(format!("websocket_url must start with ws:// or wss:// (got: {})", url));
            }
        }

        Ok(())
    }
}

/// Registers this Home Assistant instance with the cloud relay and returns the
/// (instance_id, websocket_url, websocket_token) it was assigned.
async fn bootstrap_from_cloud(cloud_url: &str) -> Result<(String, String, String), String> {
    #[derive(Deserialize)]
    struct ProvisionData {
        #[serde(rename = "instanceId")]
        instance_id: String,
        #[serde(rename = "tunnelToken")]
        tunnel_token: String,
    }

    #[derive(Deserialize)]
    struct ProvisionResponse {
        success: bool,
        data: Option<ProvisionData>,
        message: Option<String>,
    }

    let trimmed = cloud_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("cloud_url is not configured".to_string());
    }

    let ws_base = if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{}", rest)
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{}", rest)
    } else {
        return Err(format!("cloud_url must start with http:// or https:// (got: {})", trimmed));
    };

    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "Home Assistant".to_string());
    let endpoint = format!("{}/api/instances/provision", trimmed);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let response = client
        .post(&endpoint)
        .json(&serde_json::json!({ "label": hostname }))
        .send()
        .await
        .map_err(|e| format!("Failed to reach cloud relay at {}: {}", endpoint, e))?;

    let status = response.status();
    let parsed: ProvisionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse cloud provisioning response ({}): {}", status, e))?;

    if !status.is_success() || !parsed.success {
        return Err(parsed.message.unwrap_or_else(|| format!("Cloud relay provisioning request failed ({})", status)));
    }

    let data = parsed.data.ok_or_else(|| "Cloud relay response was missing provisioning data".to_string())?;
    let websocket_url = format!("{}/ws", ws_base);

    Ok((data.instance_id, websocket_url, data.tunnel_token))
}

impl ConfigManager {
    pub fn new() -> Self {
        // In HA, options are stored in /data/options.json
        // Let's determine where to store our merged config file.
        let ha_options_path = Path::new("/data/options.json");
        
        let mut base_config = AppConfig::default();

        // 1. Try to load from HA options.json if present
        if ha_options_path.exists() {
            match fs::read_to_string(ha_options_path) {
                Ok(content) => {
                    match serde_json::from_str::<AppConfig>(&content) {
                        Ok(ha_config) => {
                            info!("Loaded options from Home Assistant options.json");
                            base_config = ha_config;
                        }
                        Err(e) => {
                            warn!("Failed to parse HA options.json, using defaults: {}", e);
                        }
                    }
                }
                Err(e) => {
                    warn!("Failed to read HA options.json, using defaults: {}", e);
                }
            }
        } else {
            // Local development fallback
            let local_options = Path::new("options.json");
            if local_options.exists() {
                if let Ok(content) = fs::read_to_string(local_options) {
                    if let Ok(local_config) = serde_json::from_str::<AppConfig>(&content) {
                        info!("Loaded options from local options.json");
                        base_config = local_config;
                    }
                }
            }
        }

        if let Err(err) = base_config.validate_bridge_settings() {
            warn!("Relay configuration validation warning: {}", err);
        }

        // Ensure directories exist
        let data_dir_path = Path::new(&base_config.data_dir);
        if !data_dir_path.exists() {
            let _ = fs::create_dir_all(data_dir_path);
        }

        // Overlay runtime modifications from data_dir/app_config.json
        let overlay_path = data_dir_path.join("app_config.json");
        if overlay_path.exists() {
            if let Ok(content) = fs::read_to_string(&overlay_path) {
                match serde_json::from_str::<AppConfig>(&content) {
                    Ok(overlay) => {
                        info!("Applying overlay configuration from {:?}", overlay_path);
                        // Overlay non-empty fields
                        if !overlay.data_dir.is_empty() {
                            base_config.data_dir = overlay.data_dir;
                        }
                        if !overlay.scan_dirs.is_empty() {
                            base_config.scan_dirs = overlay.scan_dirs;
                        }
                        if overlay.instance_id.is_some() {
                            base_config.instance_id = overlay.instance_id;
                        }
                        if overlay.websocket_url.is_some() {
                            base_config.websocket_url = overlay.websocket_url;
                        }
                        if overlay.websocket_token.is_some() {
                            base_config.websocket_token = overlay.websocket_token;
                        }
                    }
                    Err(e) => {
                        warn!("Failed to parse runtime overlay configuration: {}", e);
                    }
                }
            }
        }

        Self {
            config_path: overlay_path,
            current_config: Arc::new(RwLock::new(base_config)),
        }
    }

    pub fn get_config(&self) -> AppConfig {
        self.current_config.read().unwrap().clone()
    }

    /// If no relay credentials are configured yet, fetch them automatically from the cloud
    /// relay so the user never has to manually enter an instance id, URL, or token.
    pub async fn ensure_cloud_registration(&self) {
        let config = self.get_config();
        let has_instance = config.instance_id.as_ref().is_some_and(|v| !v.trim().is_empty());
        let has_url = config.websocket_url.as_ref().is_some_and(|v| !v.trim().is_empty());
        let has_token = config.websocket_token.as_ref().is_some_and(|v| !v.trim().is_empty());
        if has_instance || has_url || has_token {
            return;
        }

        match bootstrap_from_cloud(&config.cloud_url).await {
            Ok((instance_id, websocket_url, websocket_token)) => {
                let mut updated = config;
                updated.instance_id = Some(instance_id);
                updated.websocket_url = Some(websocket_url);
                updated.websocket_token = Some(websocket_token);
                match self.update_config(updated) {
                    Ok(()) => info!("Auto-provisioned relay credentials from cloud; no manual configuration required"),
                    Err(e) => warn!("Fetched cloud relay credentials but failed to persist them: {}", e),
                }
            }
            Err(e) => {
                warn!("Automatic cloud registration failed: {}. The relay bridge will stay disabled until credentials are configured.", e);
            }
        }
    }

    pub fn get_config_arc(&self) -> Arc<RwLock<AppConfig>> {
        self.current_config.clone()
    }

    pub fn update_config(&self, new_config: AppConfig) -> Result<(), String> {
        new_config.validate_bridge_settings()
            .map_err(|err| format!("Invalid relay configuration: {}", err))?;

        // Ensure data dir exists
        let data_dir_path = Path::new(&new_config.data_dir);
        if !data_dir_path.exists() {
            fs::create_dir_all(data_dir_path)
                .map_err(|e| format!("Failed to create data directory: {}", e))?;
        }

        // Update in memory
        {
            let mut current = self.current_config.write().unwrap();
            *current = new_config.clone();
        }

        // Persist to overlay path
        let content = serde_json::to_string_pretty(&new_config)
            .map_err(|e| format!("Failed to serialize config: {}", e))?;
        
        fs::write(&self.config_path, content)
            .map_err(|e| format!("Failed to write config file: {}", e))?;

        info!("Persisted updated configuration to {:?}", self.config_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{AppConfig, default_cloud_url};

    #[test]
    fn partial_bridge_config_is_rejected() {
        let config = AppConfig {
            data_dir: "/tmp/data".to_string(),
            scan_dirs: vec!["/tmp".to_string()],
            instance_id: Some("instance-abc".to_string()),
            websocket_url: None,
            websocket_token: Some("token-abc".to_string()),
            cloud_url: default_cloud_url(),
        };

        let result = config.validate_bridge_settings();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Partial relay configuration"));
    }

    #[test]
    fn valid_bridge_config_is_accepted() {
        let config = AppConfig {
            data_dir: "/tmp/data".to_string(),
            scan_dirs: vec!["/tmp".to_string()],
            instance_id: Some("instance-abc".to_string()),
            websocket_url: Some("wss://relay.example.com/ws".to_string()),
            websocket_token: Some("token-abc".to_string()),
            cloud_url: default_cloud_url(),
        };

        assert!(config.validate_bridge_settings().is_ok());
    }
}
