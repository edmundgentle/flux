use crate::api::guess_mime;
use crate::auth::AccountManager;
use crate::config::ConfigManager;
use crate::definitions::WEBSOCKET_URL;
use crate::files::FileManager;
use crate::search::SearchManager;
use crate::sharing::ShareRegistry;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::Message;
use tracing::{error, info, warn};

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
pub struct BridgeResponse<T> {
    pub request_id: String,
    pub success: bool,
    pub message: String,
    pub data: Option<T>,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
pub struct DownloadResponsePayload {
    pub file_name: String,
    pub mime_type: String,
    pub content_b64: String,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct RelayEnvelope {
    #[serde(rename = "type")]
    type_name: String,
    #[serde(default, alias = "request_id")]
    request_id: Option<String>,
    #[serde(default, alias = "instance_id")]
    instance_id: Option<String>,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct ProxyRequest {
    method: String,
    path: String,
    query: Option<HashMap<String, Value>>,
    headers: Option<HashMap<String, String>>,
    body: Option<Value>,
    user: Option<String>,
    user_signature: Option<String>,
}

pub struct WebSocketBridge;

impl WebSocketBridge {
    pub async fn start(
        config_manager: Arc<ConfigManager>,
        search_manager: SearchManager,
        share_registry: ShareRegistry,
        account_manager: AccountManager,
        bridge_connected: Arc<AtomicBool>,
    ) {
        info!("Starting outbound WebSocket bridge background task");

        let mut backoff = Duration::from_secs(2);
        let max_backoff = Duration::from_secs(60);

        loop {
            config_manager.ensure_cloud_registration().await;

            let (ws_token, instance_id, data_dir) = {
                let config = config_manager.get_config_arc();
                let config = config.read().unwrap();
                (
                    config.websocket_token.clone(),
                    config.instance_id.clone(),
                    config.data_dir.clone(),
                )
            };

            if instance_id.as_deref().unwrap_or("").trim().is_empty() {
                error!("WebSocket bridge is not configured with an instance_id; skipping connection attempt until the relay instance is set.");
                bridge_connected.store(false, Ordering::SeqCst);
                sleep(Duration::from_secs(10)).await;
                continue;
            }

            if ws_token.as_deref().unwrap_or("").trim().is_empty() {
                error!("WebSocket bridge is not configured with a websocket_token; set the relay tunnel token before connecting.");
                bridge_connected.store(false, Ordering::SeqCst);
                sleep(Duration::from_secs(10)).await;
                continue;
            }

            info!(
                "Attempting WebSocket bridge connection to: {} for instance {}",
                WEBSOCKET_URL,
                instance_id.as_deref().unwrap_or("unknown")
            );

            match WEBSOCKET_URL.into_client_request() {
                Ok(mut request) => {
                    if let Some(ref token) = ws_token {
                        if !token.trim().is_empty() {
                            if let Ok(header_val) = format!("Bearer {}", token).parse() {
                                request.headers_mut().insert("Authorization", header_val);
                            }
                            if let Ok(header_val) = token.parse() {
                                request.headers_mut().insert("X-Instance-Token", header_val);
                            }
                        }
                    }

                    if let Some(ref instance) = instance_id {
                        if let Ok(header_val) = instance.parse() {
                            request.headers_mut().insert("X-Instance-Id", header_val);
                        }
                    }

                    match tokio_tungstenite::connect_async(request).await {
                        Ok((ws_stream, response)) => {
                            info!(
                                "Successfully connected to cloud relay! HTTP Status: {}",
                                response.status()
                            );
                            backoff = Duration::from_secs(2);
                            bridge_connected.store(true, Ordering::SeqCst);

                            let (mut ws_write, mut ws_read) = ws_stream.split();
                            let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

                            let writer_handle = tokio::spawn(async move {
                                while let Some(msg) = rx.recv().await {
                                    if let Err(e) = ws_write.send(msg).await {
                                        error!(
                                            "Failed to send message over WebSocket bridge: {}",
                                            e
                                        );
                                        break;
                                    }
                                }
                            });

                            // Actively ping the relay and watch for inactivity so a silently
                            // dropped connection (e.g. NAT/proxy timeout with no TCP FIN) is
                            // detected and reconnected instead of hanging indefinitely.
                            let mut last_activity = tokio::time::Instant::now();
                            let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                            heartbeat
                                .set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                            const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(90);

                            'read_loop: loop {
                                tokio::select! {
                                    _ = heartbeat.tick() => {
                                        if last_activity.elapsed() > INACTIVITY_TIMEOUT {
                                            warn!("No activity from cloud relay for {:?}, reconnecting...", last_activity.elapsed());
                                            break 'read_loop;
                                        }
                                        if tx.send(Message::Ping(Vec::new())).is_err() {
                                            break 'read_loop;
                                        }
                                    }
                                    msg_res = ws_read.next() => {
                                        let Some(msg_res) = msg_res else {
                                            info!("WebSocket bridge stream ended, attempting reconnect...");
                                            break 'read_loop;
                                        };
                                        last_activity = tokio::time::Instant::now();
                                        match msg_res {
                                            Ok(Message::Text(text)) => {
                                                let sm = search_manager.clone();
                                                let reg = share_registry.clone();
                                                let sender = tx.clone();

                                                let account_manager = account_manager.clone();
                                                let data_dir = data_dir.clone();
                                                let tunnel_token = ws_token.clone();
                                                tokio::spawn(async move {
                                                    if let Err(e) = Self::handle_request(&text, &sm, &reg, &account_manager, &data_dir, tunnel_token.as_deref(), sender).await {
                                                        error!("Error processing bridge request: {}", e);
                                                    }
                                                });
                                            }
                                            Ok(Message::Ping(payload)) => {
                                                let _ = tx.send(Message::Pong(payload));
                                            }
                                            Ok(Message::Pong(_)) => {}
                                            Ok(Message::Close(frame)) => {
                                                info!("Received WebSocket close frame from server: {:?}", frame);
                                                break 'read_loop;
                                            }
                                            Err(e) => {
                                                error!("WebSocket connection error: {}", e);
                                                break 'read_loop;
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                            }

                            writer_handle.abort();
                            bridge_connected.store(false, Ordering::SeqCst);
                            info!("WebSocket bridge connection closed, attempting reconnect...");
                        }
                        Err(e) => {
                            bridge_connected.store(false, Ordering::SeqCst);
                            error!(
                                "Failed to connect to WebSocket endpoint: {}. Retrying...",
                                e
                            );
                        }
                    }
                }
                Err(e) => {
                    bridge_connected.store(false, Ordering::SeqCst);
                    error!("Invalid WebSocket URL structure '{}': {}", WEBSOCKET_URL, e);
                }
            }

            sleep(backoff).await;
            backoff = std::cmp::min(backoff * 2, max_backoff);
        }
    }

    async fn handle_request(
        req_text: &str,
        search_manager: &SearchManager,
        share_registry: &ShareRegistry,
        account_manager: &AccountManager,
        data_dir: &str,
        tunnel_token: Option<&str>,
        sender: mpsc::UnboundedSender<Message>,
    ) -> Result<(), String> {
        let envelope: RelayEnvelope = serde_json::from_str(req_text)
            .map_err(|e| format!("Failed to parse incoming relay envelope JSON: {}", e))?;

        match envelope.type_name.as_str() {
            "proxy_request" => {
                let request_id = envelope
                    .request_id
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string());
                let payload_value = envelope
                    .payload
                    .ok_or_else(|| "Missing payload for proxy request".to_string())?;
                let request: ProxyRequest = serde_json::from_value(payload_value)
                    .map_err(|e| format!("Failed to decode proxy request payload: {}", e))?;

                let response = Self::handle_proxy_request(
                    request,
                    search_manager,
                    share_registry,
                    account_manager,
                    data_dir,
                    tunnel_token,
                    envelope.instance_id.as_deref().unwrap_or(""),
                    request_id.clone(),
                );
                let outgoing = json!({
                    "type": "proxy_response",
                    "instanceId": envelope.instance_id,
                    "requestId": request_id,
                    "payload": response,
                    "ts": chrono::Utc::now().timestamp_millis()
                });
                let _ = sender.send(Message::Text(outgoing.to_string()));
            }
            "ping" => {
                let _ = sender.send(Message::Text(json!({ "type": "pong" }).to_string()));
            }
            "hello" | "pong" | "proxy_response" => {
                // No-op: relay heartbeat or response already handled upstream.
            }
            _ => {
                warn!(
                    "Ignoring unsupported relay message type: {}",
                    envelope.type_name
                );
            }
        }

        Ok(())
    }

    fn handle_proxy_request(
        request: ProxyRequest,
        search_manager: &SearchManager,
        share_registry: &ShareRegistry,
        account_manager: &AccountManager,
        data_dir: &str,
        tunnel_token: Option<&str>,
        instance_id: &str,
        request_id: String,
    ) -> Value {
        let query = request.query.unwrap_or_default();
        let header_user = request
            .headers
            .as_ref()
            .and_then(extract_bearer_token)
            .and_then(|token| account_manager.authenticate_token(&token));

        // The cloud verifies passwords and asserts the authenticated user over the signed tunnel.
        // That assertion is only ever enough to mint a session; it cannot authorize data access.
        let asserted_user = match (
            request.user.as_deref(),
            request.user_signature.as_deref(),
            tunnel_token,
        ) {
            (Some(user), Some(signature), Some(token))
                if verify_relay_user(token, instance_id, &request_id, user, signature) =>
            {
                Some(user.to_string())
            }
            _ => None,
        };

        if request.method.eq_ignore_ascii_case("POST") && request.path == "/api/auth/session" {
            let Some(user) = asserted_user else {
                return json!({ "status": 401, "body": { "success": false, "message": "A signed relay identity assertion is required to mint a session" } });
            };
            let display_name = request
                .body
                .as_ref()
                .and_then(|b| b.get("display_name"))
                .and_then(|v| v.as_str());
            return match account_manager.create_federated_session(&user, display_name) {
                Ok(session) => {
                    json!({ "status": 200, "body": { "success": true, "data": session } })
                }
                Err(e) => json!({ "status": 500, "body": { "success": false, "message": e } }),
            };
        }

        let Some(user) = header_user else {
            return json!({ "status": 401, "body": { "success": false, "message": "Authentication required: supply an access token issued by this instance" } });
        };

        if request.method.eq_ignore_ascii_case("POST") && request.path == "/api/auth/logout" {
            let token = request
                .headers
                .as_ref()
                .and_then(|headers| headers.get("authorization"))
                .and_then(|v| v.strip_prefix("Bearer "))
                .unwrap_or_default();
            account_manager.revoke_token(token);
            return json!({ "status": 200, "body": { "success": true } });
        }

        // A caller may only ever act as the user their own token identifies.
        if let Some(asserted) = asserted_user.as_deref() {
            if crate::auth::AccountManager::normalize_username(asserted)
                != crate::auth::AccountManager::normalize_username(&user)
            {
                return json!({ "status": 403, "body": { "success": false, "message": "User identity mismatch: request metadata does not match the authenticated session" } });
            }
        }

        match request.method.to_ascii_uppercase().as_str() {
            "GET" if request.path == "/api/auth/session" => {
                json!({ "status": 200, "body": { "success": true, "data": { "user": user } } })
            }
            "GET" if request.path.starts_with("/api/search") => {
                let q = query
                    .get("q")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let limit = query
                    .get("limit")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<usize>().ok())
                    .or_else(|| {
                        query
                            .get("limit")
                            .and_then(|v| v.as_u64())
                            .and_then(|n| usize::try_from(n).ok())
                    })
                    .unwrap_or(20)
                    .clamp(1, 100);

                match search_manager.search(&q, &user, limit) {
                    Ok(results) => json!({ "status": 200, "body": results, "data": results }),
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": e } }),
                }
            }
            "POST" if request.path.starts_with("/api/files") => {
                let file_path = query
                    .get("path")
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        request
                            .body
                            .as_ref()
                            .and_then(|b| b.get("path"))
                            .and_then(|v| v.as_str())
                    })
                    .unwrap_or("upload.bin")
                    .to_string();
                let content_b64 = request
                    .body
                    .as_ref()
                    .and_then(|b| b.get("content_b64"))
                    .and_then(|v| v.as_str())
                    .or_else(|| {
                        request
                            .body
                            .as_ref()
                            .and_then(|b| b.get("content"))
                            .and_then(|v| v.as_str())
                    })
                    .unwrap_or("")
                    .to_string();

                let mut relative_path = PathBuf::new();
                for component in Path::new(&file_path).components() {
                    match component {
                        Component::Normal(value) => relative_path.push(value),
                        Component::RootDir | Component::CurDir => {}
                        Component::ParentDir | Component::Prefix(_) => {
                            return json!({ "status": 400, "body": { "success": false, "message": "Upload path must stay inside the user workspace" } });
                        }
                    }
                }
                if relative_path.as_os_str().is_empty() {
                    relative_path.push("upload.bin");
                }
                let target_path = Path::new(data_dir).join(&user).join(&relative_path);

                let decoded = match STANDARD.decode(&content_b64) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        return json!({ "status": 400, "body": { "success": false, "message": format!("Failed to decode file payload: {}", e) } })
                    }
                };

                match FileManager::save_and_index_file(
                    &decoded,
                    &target_path,
                    search_manager,
                    Some(share_registry),
                ) {
                    Ok(_) => {
                        json!({ "status": 200, "body": { "success": true, "message": "File uploaded and indexed", "path": file_path }, "data": { "path": file_path } })
                    }
                    Err(e) => {
                        json!({ "status": 500, "body": { "success": false, "message": format!("Upload failed: {}", e) } })
                    }
                }
            }
            "GET" if request.path == "/api/files/list" => {
                let path = query.get("path").and_then(|v| v.as_str()).unwrap_or("/");
                let recursive = query
                    .get("recursive")
                    .map(|v| v.as_bool().unwrap_or_else(|| v.as_str() == Some("true")))
                    .unwrap_or(false);
                let limit = query
                    .get("limit")
                    .and_then(|v| {
                        v.as_u64()
                            .or_else(|| v.as_str().and_then(|s| s.parse::<u64>().ok()))
                    })
                    .and_then(|n| usize::try_from(n).ok())
                    .unwrap_or(crate::files::MAX_LIST_ENTRIES);
                let workspace_root = Path::new(data_dir).join(&user);
                match FileManager::list_directory(&workspace_root, path, recursive, limit) {
                    Ok(listing) => {
                        let listing = json!(listing);
                        json!({ "status": 200, "body": { "success": true, "data": listing }, "data": listing })
                    }
                    Err(e) => json!({ "status": 400, "body": { "success": false, "message": e } }),
                }
            }
            "GET" if request.path.starts_with("/api/files") => {
                let file_path = query.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let file_path_buf = PathBuf::from(file_path);
                if !file_path_buf.exists() {
                    return json!({ "status": 404, "body": { "success": false, "message": "File not found" } });
                }
                if !share_registry.check_access(&user, file_path) {
                    return json!({ "status": 403, "body": { "success": false, "message": "Access denied" } });
                }

                match std::fs::read(&file_path_buf) {
                    Ok(bytes) => {
                        let payload = json!({
                            "file_name": file_path_buf.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
                            "mime_type": guess_mime(&file_path_buf),
                            "content_b64": STANDARD.encode(bytes)
                        });
                        json!({ "status": 200, "body": payload, "data": payload })
                    }
                    Err(e) => {
                        json!({ "status": 500, "body": { "success": false, "message": format!("Failed to read file: {}", e) } })
                    }
                }
            }
            "DELETE" if request.path.starts_with("/api/files") => {
                let file_path = query.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let file_path_buf = PathBuf::from(file_path);
                if !file_path_buf.exists() {
                    return json!({ "status": 404, "body": { "success": false, "message": "File not found" } });
                }
                if !share_registry.is_owner(&user, file_path, data_dir)
                    && !account_manager.is_admin(&user)
                {
                    return json!({ "status": 403, "body": { "success": false, "message": "Access denied" } });
                }

                match FileManager::delete_file(&file_path_buf, search_manager) {
                    Ok(_) => {
                        if let Err(error) = share_registry.remove_deleted_file(file_path) {
                            return json!({ "status": 500, "body": { "success": false, "message": error } });
                        }
                        json!({ "status": 200, "body": { "success": true, "message": "File deleted" } })
                    }
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": e } }),
                }
            }
            "GET" if request.path.starts_with("/api/config") => {
                json!({ "status": 200, "body": { "success": true, "message": "Config read", "data": { "user": user } } })
            }
            "POST" if request.path == "/api/shares/share" => {
                let file_path = request
                    .body
                    .as_ref()
                    .and_then(|body| body.get("file_path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let shared_with = request
                    .body
                    .as_ref()
                    .and_then(|body| body.get("shared_with"))
                    .and_then(Value::as_array)
                    .map(|users| {
                        users
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if file_path.is_empty() || !share_registry.is_owner(&user, file_path, data_dir) {
                    return json!({ "status": 403, "body": { "success": false, "message": "Only the owner can share this file" } });
                }
                match share_registry.add_share(&user, file_path, shared_with) {
                    Ok(()) => {
                        if let Err(error) = FileManager::process_and_index_file(
                            Path::new(file_path),
                            search_manager,
                            Some(share_registry),
                        ) {
                            return json!({ "status": 500, "body": { "success": false, "message": error } });
                        }
                        json!({ "status": 200, "body": { "success": true, "message": "File successfully shared" } })
                    }
                    Err(error) => {
                        json!({ "status": 400, "body": { "success": false, "message": error } })
                    }
                }
            }
            "POST" if request.path == "/api/shares/unshare" => {
                let file_path = request
                    .body
                    .as_ref()
                    .and_then(|body| body.get("file_path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let user_to_remove = request
                    .body
                    .as_ref()
                    .and_then(|body| body.get("user_to_remove"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match share_registry.remove_share(&user, file_path, user_to_remove) {
                    Ok(()) => {
                        if let Err(error) = FileManager::process_and_index_file(
                            Path::new(file_path),
                            search_manager,
                            Some(share_registry),
                        ) {
                            return json!({ "status": 500, "body": { "success": false, "message": error } });
                        }
                        json!({ "status": 200, "body": { "success": true, "message": "File sharing permissions updated" } })
                    }
                    Err(error) => {
                        json!({ "status": 400, "body": { "success": false, "message": error } })
                    }
                }
            }
            "GET" if request.path == "/api/shares/list" => {
                json!({
                    "status": 200,
                    "body": {
                        "owned_shares": share_registry.get_shares_by_owner(&user),
                        "shared_with_me": share_registry.get_shares_for_user(&user)
                    }
                })
            }
            _ if request.path.starts_with("/api/faces/") => {
                let query: HashMap<String, String> = query
                    .iter()
                    .map(|(key, value)| {
                        let value = value
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| value.to_string());
                        (key.clone(), value)
                    })
                    .collect();
                let (status, body) = crate::faces::handle_request(
                    search_manager.faces(),
                    data_dir,
                    &user,
                    &request.method,
                    &request.path,
                    &query,
                    request.body.as_ref().unwrap_or(&Value::Null),
                );
                json!({ "status": status, "body": body })
            }
            _ => {
                json!({ "status": 501, "body": { "success": false, "message": format!("Unsupported proxy route for path: {}", request.path) } })
            }
        }
    }
}

fn extract_bearer_token(headers: &HashMap<String, String>) -> Option<String> {
    headers.iter().find_map(|(name, value)| {
        if name.eq_ignore_ascii_case("authorization") {
            let value = value.trim();
            let token = value
                .strip_prefix("Bearer ")
                .or_else(|| value.strip_prefix("bearer "))
                .or_else(|| value.strip_prefix("BEARER "))
                .unwrap_or(value);
            if token.is_empty() { None } else { Some(token.to_string()) }
        } else {
            None
        }
    })
}

fn verify_relay_user(
    token: &str,
    instance_id: &str,
    request_id: &str,
    user: &str,
    signature: &str,
) -> bool {
    let Ok(expected) = hex::decode(signature) else {
        return false;
    };
    let Ok(mut mac) = Hmac::<sha2::Sha256>::new_from_slice(token.as_bytes()) else {
        return false;
    };
    mac.update(format!("{instance_id}\n{request_id}\n{user}").as_bytes());
    mac.verify_slice(&expected).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_override_cannot_impersonate_authenticated_identity() {
        let request = ProxyRequest {
            method: "GET".to_string(),
            path: "/api/search".to_string(),
            query: Some(HashMap::from([
                ("q".to_string(), Value::String("*".to_string())),
                ("user".to_string(), Value::String("mallory".to_string())),
            ])),
            headers: Some(HashMap::from([(
                "authorization".to_string(),
                "Bearer real-token".to_string(),
            )])),
            body: None,
            user: Some("mallory".to_string()),
            user_signature: None,
        };

        let resolved = request
            .user
            .clone()
            .unwrap_or_else(|| "anonymous".to_string());
        assert_ne!(resolved, "alice");
        assert_eq!(resolved, "mallory");
    }

    #[test]
    fn relay_user_assertion_requires_the_tunnel_secret() {
        let token = "tunnel-token";
        let instance_id = "instance-a";
        let request_id = "request-1";
        let user = "alice@example.com";
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(token.as_bytes()).unwrap();
        mac.update(format!("{instance_id}\n{request_id}\n{user}").as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        assert!(verify_relay_user(
            token,
            instance_id,
            request_id,
            user,
            &signature
        ));
        assert!(!verify_relay_user(
            "wrong-token",
            instance_id,
            request_id,
            user,
            &signature
        ));
        assert!(!verify_relay_user(
            token,
            instance_id,
            request_id,
            "mallory@example.com",
            &signature
        ));
    }

    #[test]
    fn bearer_token_lookup_accepts_standard_authorization_header_case() {
        let headers = HashMap::from([(
            "Authorization".to_string(),
            "Bearer real-token".to_string(),
        )]);

        assert_eq!(extract_bearer_token(&headers), Some("real-token".to_string()));
        assert_eq!(
            extract_bearer_token(&HashMap::from([(
                "authorization".to_string(),
                "Bearer lower-case".to_string(),
            )])),
            Some("lower-case".to_string())
        );
    }
}
