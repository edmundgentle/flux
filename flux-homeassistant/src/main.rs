mod config;
mod definitions;
mod storage;
mod cv;
mod detect;
mod search;
mod files;
mod bridge;
mod api;
mod sharing;
mod auth;

use config::ConfigManager;
use search::SearchManager;
use files::FileManager;
use bridge::WebSocketBridge;
use api::{AppState, create_router};
use auth::AccountManager;
use sharing::ShareRegistry;

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use tracing::{error, info};

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("Shutdown signal received");
}

#[tokio::main]
async fn main() {
    // 1. Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,flux_homeassistant=debug")),
        )
        .init();

    info!("Initializing Local Personal Search & Vision Server (Multi-User Edition)...");

    // 2. Load settings
    let config_manager = Arc::new(ConfigManager::new());

    // On first boot with no relay credentials configured, auto-provision them from the
    // cloud so the user never has to manually enter an instance id, URL, or token.
    config_manager.ensure_cloud_registration().await;

    let current_config = config_manager.get_config();
    if let Err(err) = current_config.validate_bridge_settings() {
        error!("Rejected invalid relay configuration: {}", err);
        std::process::exit(1);
    }

    info!(
        "Loaded settings: data_dir={}, scan_dirs={:?}, instance_id={:?}",
        current_config.data_dir,
        current_config.scan_dirs,
        current_config.instance_id
    );

    // 3. Initialize account manager and share registry
    let account_manager = AccountManager::new(&current_config.data_dir);
    let share_registry = ShareRegistry::new(&current_config.data_dir);

    // 4. Initialize Tantivy search index
    let index_dir = format!("{}/index", current_config.data_dir);
    let search_manager = match SearchManager::new(&index_dir) {
        Ok(sm) => sm,
        Err(e) => {
            error!("CRITICAL ERROR: Failed to initialize search index: {}", e);
            std::process::exit(1);
        }
    };

    // 5. Run startup directory scans for all configured search roots
    for dir in &current_config.scan_dirs {
        let path = std::path::Path::new(dir);
        if path.exists() && path.is_dir() {
            let sm_clone = search_manager.clone();
            let path_buf = path.to_path_buf();
            let reg_clone = share_registry.clone();
            // Run in blocking thread pool so it doesn't block server startup
            tokio::task::spawn_blocking(move || {
                FileManager::scan_directory_recursive(&path_buf, &sm_clone, Some(&reg_clone));
            });
        } else {
            info!("Scan directory {:?} does not exist. Skipping initial scan.", dir);
        }
    }

    // 6. Start background file watcher for real-time monitoring
    let watcher_sm = search_manager.clone();
    let watcher_dirs = current_config.scan_dirs.clone();
    let watcher_reg = share_registry.clone();
    let _watcher = match FileManager::start_file_watcher(watcher_dirs, watcher_sm, Some(watcher_reg)) {
        Ok(w) => {
            info!("Background file watcher started successfully.");
            Some(w)
        }
        Err(e) => {
            error!("Failed to initialize directory watcher: {}", e);
            None
        }
    };

    // 7. Start outbound WebSocket client/bridge
    let bridge_connected = Arc::new(AtomicBool::new(false));
    let bridge_config = config_manager.clone();
    let bridge_sm = search_manager.clone();
    let bridge_reg = share_registry.clone();
    let bridge_accounts = account_manager.clone();
    let bridge_connected_flag = bridge_connected.clone();
    tokio::spawn(async move {
        WebSocketBridge::start(bridge_config, bridge_sm, bridge_reg, bridge_accounts, bridge_connected_flag).await;
    });

    // 8. Setup and start REST API
    let state = AppState {
        config_manager: config_manager.clone(),
        search_manager,
        share_registry,
        account_manager,
        bridge_connected,
    };
    
    let app = create_router(state);
    let addr = SocketAddr::from(([0, 0, 0, 0], 8080));
    
    info!("Local personal search API listening on: http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("CRITICAL ERROR: Failed to bind to address {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        error!("REST API Server execution error: {}", e);
    }
}
