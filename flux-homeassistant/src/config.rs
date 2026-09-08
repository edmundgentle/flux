use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub data_dir: String,
    pub scan_dirs: Vec<String>,
    pub tenant_id: Option<String>,
    pub websocket_url: Option<String>,
    pub websocket_token: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            data_dir: "/config/search_vision".to_string(),
            scan_dirs: vec!["/share".to_string(), "/media".to_string()],
            tenant_id: None,
            websocket_url: None,
            websocket_token: None,
        }
    }
}

pub struct ConfigManager {
    config_path: PathBuf,
    current_config: Arc<RwLock<AppConfig>>,
}

impl AppConfig {
    pub fn validate_bridge_settings(&self) -> Result<(), String> {
        let has_tenant = self.tenant_id.as_ref().is_some_and(|value| !value.trim().is_empty());
        let has_url = self.websocket_url.as_ref().is_some_and(|value| !value.trim().is_empty());
        let has_token = self.websocket_token.as_ref().is_some_and(|value| !value.trim().is_empty());

        let configured_count = [has_tenant, has_url, has_token].iter().filter(|&&value| value).count();
        if configured_count == 0 {
            return Ok(());
        }

        if configured_count != 3 {
            return Err("Partial relay configuration detected: tenant_id, websocket_url, and websocket_token must all be set together".to_string());
        }

        if let Some(url) = &self.websocket_url {
            if !url.starts_with("ws://") && !url.starts_with("wss://") {
                return Err(format!("websocket_url must start with ws:// or wss:// (got: {})", url));
            }
        }

        Ok(())
    }
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
                        if overlay.tenant_id.is_some() {
                            base_config.tenant_id = overlay.tenant_id;
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
    use super::AppConfig;

    #[test]
    fn partial_bridge_config_is_rejected() {
        let config = AppConfig {
            data_dir: "/tmp/data".to_string(),
            scan_dirs: vec!["/tmp".to_string()],
            tenant_id: Some("tenant-abc".to_string()),
            websocket_url: None,
            websocket_token: Some("token-abc".to_string()),
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
            tenant_id: Some("tenant-abc".to_string()),
            websocket_url: Some("wss://relay.example.com/ws".to_string()),
            websocket_token: Some("token-abc".to_string()),
        };

        assert!(config.validate_bridge_settings().is_ok());
    }
}
