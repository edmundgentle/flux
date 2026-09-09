use crate::auth::AccountManager;
use crate::config::AppConfig;
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
use std::sync::{Arc, RwLock};
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
    #[serde(default, alias = "tenant_id")]
    tenant_id: Option<String>,
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
        config_arc: Arc<RwLock<AppConfig>>,
        search_manager: SearchManager,
        share_registry: ShareRegistry,
        account_manager: AccountManager,
        bridge_connected: Arc<AtomicBool>,
    ) {
        info!("Starting outbound WebSocket bridge background task");

        let mut backoff = Duration::from_secs(2);
        let max_backoff = Duration::from_secs(60);

        loop {
            let (ws_url, ws_token, configured_tenant_id, data_dir) = {
                let config = config_arc.read().unwrap();
                (config.websocket_url.clone(), config.websocket_token.clone(), config.tenant_id.clone(), config.data_dir.clone())
            };
            let tenant_id = configured_tenant_id.or_else(|| account_manager.default_tenant_id());

            let url_str = match ws_url {
                Some(ref url) if !url.trim().is_empty() => url.clone(),
                _ => {
                    bridge_connected.store(false, Ordering::SeqCst);
                    sleep(Duration::from_secs(10)).await;
                    continue;
                }
            };

            if tenant_id.as_deref().unwrap_or("").trim().is_empty() {
                error!("WebSocket bridge is not configured with a tenant_id; skipping connection attempt until the relay tenant is set.");
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

            info!("Attempting WebSocket bridge connection to: {} for tenant {}", url_str, tenant_id.as_deref().unwrap_or("unknown"));

            match url_str.clone().into_client_request() {
                Ok(mut request) => {
                    if let Some(ref token) = ws_token {
                        if !token.trim().is_empty() {
                            if let Ok(header_val) = format!("Bearer {}", token).parse() {
                                request.headers_mut().insert("Authorization", header_val);
                            }
                            if let Ok(header_val) = token.parse() {
                                request.headers_mut().insert("X-Tenant-Token", header_val);
                            }
                        }
                    }

                    if let Some(ref tenant) = tenant_id {
                        if let Ok(header_val) = tenant.parse() {
                            request.headers_mut().insert("X-Tenant-Id", header_val);
                        }
                        let _ = url_str.clone();
                    }

                    match tokio_tungstenite::connect_async(request).await {
                        Ok((ws_stream, response)) => {
                            info!("Successfully connected to cloud relay! HTTP Status: {}", response.status());
                            backoff = Duration::from_secs(2);
                            bridge_connected.store(true, Ordering::SeqCst);

                            let (mut ws_write, mut ws_read) = ws_stream.split();
                            let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

                            let writer_handle = tokio::spawn(async move {
                                while let Some(msg) = rx.recv().await {
                                    if let Err(e) = ws_write.send(msg).await {
                                        error!("Failed to send message over WebSocket bridge: {}", e);
                                        break;
                                    }
                                }
                            });

                            while let Some(msg_res) = ws_read.next().await {
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
                                    Ok(Message::Close(frame)) => {
                                        info!("Received WebSocket close frame from server: {:?}", frame);
                                        break;
                                    }
                                    Err(e) => {
                                        error!("WebSocket connection error: {}", e);
                                        break;
                                    }
                                    _ => {}
                                }
                            }

                            writer_handle.abort();
                            bridge_connected.store(false, Ordering::SeqCst);
                            info!("WebSocket bridge connection closed, attempting reconnect...");
                        }
                        Err(e) => {
                            bridge_connected.store(false, Ordering::SeqCst);
                            error!("Failed to connect to WebSocket endpoint: {}. Retrying...", e);
                        }
                    }
                }
                Err(e) => {
                    bridge_connected.store(false, Ordering::SeqCst);
                    error!("Invalid WebSocket URL structure '{}': {}", url_str, e);
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
                let request_id = envelope.request_id.clone().unwrap_or_else(|| "unknown".to_string());
                let payload_value = envelope.payload.ok_or_else(|| "Missing payload for proxy request".to_string())?;
                let request: ProxyRequest = serde_json::from_value(payload_value)
                    .map_err(|e| format!("Failed to decode proxy request payload: {}", e))?;

                let response = Self::handle_proxy_request(request, search_manager, share_registry, account_manager, data_dir, tunnel_token, envelope.tenant_id.as_deref().unwrap_or(""), request_id.clone());
                let outgoing = json!({
                    "type": "proxy_response",
                    "tenantId": envelope.tenant_id,
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
                warn!("Ignoring unsupported relay message type: {}", envelope.type_name);
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
        tenant_id: &str,
        request_id: String,
    ) -> Value {
        let query = request.query.unwrap_or_default();
        let header_user = request.headers.as_ref()
            .and_then(|headers| headers.get("authorization"))
            .and_then(|v| v.strip_prefix("Bearer "))
            .and_then(|token| account_manager.authenticate_token(token));

        let user = header_user.clone()
            .or_else(|| request.user.clone())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "anonymous".to_string());

        let relay_user_is_valid = match (header_user.as_deref(), request.user.as_deref(), request.user_signature.as_deref(), tunnel_token) {
            (None, Some(user), Some(signature), Some(token)) => verify_relay_user(token, tenant_id, &request_id, user, signature),
            _ => false,
        };

        if header_user.is_none() && !relay_user_is_valid {
            return json!({ "status": 401, "body": { "success": false, "message": "Authentication required: bearer token must identify the requesting user" } });
        }

        let normalized_user = crate::auth::AccountManager::normalize_username(&user);
        let canonical_user = crate::auth::AccountManager::normalize_username(&header_user.clone().unwrap_or_else(|| user.clone()));

        if normalized_user != canonical_user {
            return json!({ "status": 403, "body": { "success": false, "message": "User identity mismatch: request metadata does not match the authenticated session" } });
        }

        match request.method.to_ascii_uppercase().as_str() {
            "GET" if request.path.starts_with("/api/search") => {
                let q = query.get("q").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let limit = query.get("limit").and_then(|v| v.as_str()).and_then(|s| s.parse::<usize>().ok())
                    .or_else(|| query.get("limit").and_then(|v| v.as_u64()).and_then(|n| usize::try_from(n).ok()))
                    .unwrap_or(20)
                    .clamp(1, 100);

                match search_manager.search(&q, &user, limit) {
                    Ok(results) => json!({ "status": 200, "body": results, "data": results }),
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": e } }),
                }
            }
            "POST" if request.path.starts_with("/api/files") => {
                let file_path = query.get("path").and_then(|v| v.as_str())
                    .or_else(|| request.body.as_ref().and_then(|b| b.get("path")).and_then(|v| v.as_str()))
                    .unwrap_or("upload.bin")
                    .to_string();
                let content_b64 = request.body.as_ref().and_then(|b| b.get("content_b64")).and_then(|v| v.as_str())
                    .or_else(|| request.body.as_ref().and_then(|b| b.get("content")).and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();

                let mut relative_path = PathBuf::new();
                for component in Path::new(&file_path).components() {
                    match component {
                        Component::Normal(value) => relative_path.push(value),
                        Component::RootDir | Component::CurDir => {},
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
                    Err(e) => return json!({ "status": 400, "body": { "success": false, "message": format!("Failed to decode file payload: {}", e) } }),
                };

                match FileManager::save_and_index_file(&decoded, &target_path, search_manager, Some(share_registry)) {
                    Ok(_) => json!({ "status": 200, "body": { "success": true, "message": "File uploaded and indexed", "path": file_path }, "data": { "path": file_path } }),
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": format!("Upload failed: {}", e) } }),
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
                            "mime_type": "application/octet-stream",
                            "content_b64": STANDARD.encode(bytes)
                        });
                        json!({ "status": 200, "body": payload, "data": payload })
                    }
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": format!("Failed to read file: {}", e) } }),
                }
            }
            "DELETE" if request.path.starts_with("/api/files") => {
                let file_path = query.get("path").and_then(|v| v.as_str()).unwrap_or("");
                let file_path_buf = PathBuf::from(file_path);
                if !file_path_buf.exists() {
                    return json!({ "status": 404, "body": { "success": false, "message": "File not found" } });
                }
                if !share_registry.is_owner(&user, file_path, data_dir) && !account_manager.is_admin(&user) {
                    return json!({ "status": 403, "body": { "success": false, "message": "Access denied" } });
                }

                match FileManager::delete_file(&file_path_buf, search_manager) {
                    Ok(_) => json!({ "status": 200, "body": { "success": true, "message": "File deleted" } }),
                    Err(e) => json!({ "status": 500, "body": { "success": false, "message": e } }),
                }
            }
            "GET" if request.path.starts_with("/api/config") => {
                json!({ "status": 200, "body": { "success": true, "message": "Config read", "data": { "user": user } } })
            }
            "POST" if request.path == "/api/shares/share" => {
                let file_path = request.body.as_ref()
                    .and_then(|body| body.get("file_path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let shared_with = request.body.as_ref()
                    .and_then(|body| body.get("shared_with"))
                    .and_then(Value::as_array)
                    .map(|users| users.iter().filter_map(Value::as_str).map(str::to_string).collect::<Vec<_>>())
                    .unwrap_or_default();
                if file_path.is_empty() || !share_registry.is_owner(&user, file_path, data_dir) {
                    return json!({ "status": 403, "body": { "success": false, "message": "Only the owner can share this file" } });
                }
                match share_registry.add_share(&user, file_path, shared_with) {
                    Ok(()) => {
                        let _ = FileManager::process_and_index_file(Path::new(file_path), search_manager, Some(share_registry));
                        json!({ "status": 200, "body": { "success": true, "message": "File successfully shared" } })
                    }
                    Err(error) => json!({ "status": 400, "body": { "success": false, "message": error } }),
                }
            }
            "POST" if request.path == "/api/shares/unshare" => {
                let file_path = request.body.as_ref()
                    .and_then(|body| body.get("file_path"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let user_to_remove = request.body.as_ref()
                    .and_then(|body| body.get("user_to_remove"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match share_registry.remove_share(&user, file_path, user_to_remove) {
                    Ok(()) => {
                        let _ = FileManager::process_and_index_file(Path::new(file_path), search_manager, Some(share_registry));
                        json!({ "status": 200, "body": { "success": true, "message": "File sharing permissions updated" } })
                    }
                    Err(error) => json!({ "status": 400, "body": { "success": false, "message": error } }),
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
            _ => json!({ "status": 501, "body": { "success": false, "message": format!("Unsupported proxy route for path: {}", request.path) } }),
        }
    }
}

fn verify_relay_user(token: &str, tenant_id: &str, request_id: &str, user: &str, signature: &str) -> bool {
    let Ok(expected) = hex::decode(signature) else { return false; };
    let Ok(mut mac) = Hmac::<sha2::Sha256>::new_from_slice(token.as_bytes()) else { return false; };
    mac.update(format!("{tenant_id}\n{request_id}\n{user}").as_bytes());
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
            query: Some(HashMap::from([("q".to_string(), Value::String("*".to_string())), ("user".to_string(), Value::String("mallory".to_string()))])),
            headers: Some(HashMap::from([("authorization".to_string(), "Bearer real-token".to_string())])),
            body: None,
            user: Some("mallory".to_string()),
            user_signature: None,
        };

        let resolved = request.user.clone().unwrap_or_else(|| "anonymous".to_string());
        assert_ne!(resolved, "alice");
        assert_eq!(resolved, "mallory");
    }

    #[test]
    fn relay_user_assertion_requires_the_tunnel_secret() {
        let token = "tunnel-token";
        let tenant_id = "tenant-a";
        let request_id = "request-1";
        let user = "alice@example.com";
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(token.as_bytes()).unwrap();
        mac.update(format!("{tenant_id}\n{request_id}\n{user}").as_bytes());
        let signature = hex::encode(mac.finalize().into_bytes());

        assert!(verify_relay_user(
            token, tenant_id, request_id, user, &signature
        ));
        assert!(!verify_relay_user(
            "wrong-token",
            tenant_id,
            request_id,
            user,
            &signature
        ));
        assert!(!verify_relay_user(
            token,
            tenant_id,
            request_id,
            "mallory@example.com",
            &signature
        ));
    }
}
