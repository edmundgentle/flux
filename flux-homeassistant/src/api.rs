use crate::auth::AccountManager;
use crate::config::ConfigManager;
use crate::files::FileManager;
use crate::search::{SearchManager, SearchResult};
use crate::sharing::{Share, ShareRegistry};
use crate::storage::{MountInfo, StorageInfo, StorageManager};
use axum::extract::{Multipart, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{Html, IntoResponse};
use axum::routing::{delete, get, post};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tracing::warn;

#[derive(Clone)]
pub struct AppState {
    pub config_manager: Arc<ConfigManager>,
    pub search_manager: SearchManager,
    pub share_registry: ShareRegistry,
    pub account_manager: AccountManager,
    pub bridge_connected: Arc<AtomicBool>,
}

#[derive(Deserialize)]
pub struct SearchQueryParams {
    pub q: String,
    pub limit: Option<usize>,
    pub user: Option<String>,
}

#[derive(Deserialize)]
pub struct ScanQueryParams {
    pub path: String,
    pub user: Option<String>,
}

#[derive(Deserialize)]
pub struct FileQueryParams {
    pub path: String,
    pub user: Option<String>,
}

#[derive(Deserialize)]
pub struct ListQueryParams {
    pub path: Option<String>,
    pub recursive: Option<bool>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct UploadQueryParams {
    pub path: Option<String>,
    pub user: Option<String>,
    pub token: Option<String>,
}

#[derive(Deserialize)]
pub struct MountRequest {
    pub source: String,
    pub target: String,
    pub fs_type: Option<String>,
    pub options: Option<String>,
    pub user: Option<String>,
}

#[derive(Deserialize)]
pub struct UmountRequest {
    pub target: String,
    pub user: Option<String>,
}

#[derive(Deserialize)]
pub struct ShareRequest {
    pub file_path: String,
    pub shared_with: Vec<String>,
}

#[derive(Deserialize)]
pub struct UnshareRequest {
    pub file_path: String,
    pub user_to_remove: String, // "*" to revoke all
}

#[derive(Deserialize)]
pub struct BrowseQueryParams {
    pub user: String,
    pub path: Option<String>,
}

#[derive(Serialize)]
pub struct AccountSummary {
    pub username: String,
    pub display_name: Option<String>,
    pub role: String,
    pub created_at: String,
    pub storage_bytes: u64,
}

#[derive(Serialize)]
pub struct AdminUsersResponse {
    pub cloud_connected: bool,
    pub instance_id: Option<String>,
    pub users: Vec<AccountSummary>,
}

#[derive(Serialize)]
pub struct BrowseEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: Option<String>,
    pub relative_path: String,
}

#[derive(Serialize)]
pub struct BrowseResponse {
    pub user: String,
    pub relative_path: String,
    pub entries: Vec<BrowseEntry>,
}

#[derive(Serialize)]
pub struct ShareListResponse {
    pub owned_shares: Vec<Share>,
    pub shared_with_me: Vec<Share>,
}

#[derive(Serialize)]
pub struct ApiResponse<T> {
    pub success: bool,
    pub message: String,
    pub data: Option<T>,
}

pub fn create_router(state: AppState) -> axum::Router {
    // The envelope endpoint re-dispatches into this router, so it must not contain the
    // envelope route itself.
    let inner = inner_router(state.clone());
    let secure = axum::Router::new()
        .route("/api/secure", post(secure_envelope))
        .with_state(SecureState { app: state, inner: inner.clone() });

    inner
        .merge(secure)
        .layer(CorsLayer::permissive())
        .layer(RequestBodyLimitLayer::new(32 * 1024 * 1024))
}

fn inner_router(state: AppState) -> axum::Router {
    axum::Router::new()
        .route("/health", get(health_check))
        // Session endpoints. Tokens are minted only through the signed relay tunnel
        // (POST /api/auth/session in bridge.rs), because only the cloud verifies passwords.
        .route("/api/auth/session", get(describe_session))
        .route("/api/auth/logout", post(logout))
        // Storage endpoints
        .route("/api/storage/mounts", get(list_mounts))
        .route("/api/storage/scan", get(scan_directory))
        .route("/api/storage/mount", post(mount_device))
        .route("/api/storage/umount", post(umount_device))
        // File endpoints
        .route("/api/files/upload", post(upload_file))
        .route("/api/files/download", get(download_file))
        .route("/api/files/list", get(list_files))
        .route("/api/files", delete(delete_file))
        // Search endpoint
        .route("/api/search", get(search_index))
        // Face grouping / labelling endpoints
        .route("/api/faces/*rest", axum::routing::any(faces_endpoint))
        // Share endpoints
        .route("/api/shares/share", post(share_file))
        .route("/api/shares/unshare", post(unshare_file))
        .route("/api/shares/list", get(list_shares))
        // Admin dashboard endpoints
        .route("/api/admin/browse", get(browse_user_files))
        .route(
            "/api/admin/instance",
            get(get_instance_info).put(rename_instance),
        )
        .route(
            "/api/admin/storage",
            axum::routing::put(change_storage_location),
        )
        .route("/api/admin/instance/members", post(invite_instance_member))
        // Only reachable at root, via Home Assistant Ingress (no standalone /ui path anymore).
        .route("/", get(serve_admin_ui))
        .with_state(state)
}

#[derive(Clone)]
struct SecureState {
    app: AppState,
    inner: axum::Router,
}

fn envelope_error(status: StatusCode, message: &str) -> axum::response::Response {
    (
        status,
        Json(ApiResponse::<()> {
            success: false,
            message: message.to_string(),
            data: None,
        }),
    )
        .into_response()
}

/// Accepts an encrypted request envelope, replays it through the normal router, and returns the
/// response sealed with the same session key. Nothing about the request or response - including
/// the access token - is readable on the wire.
async fn secure_envelope(
    headers: HeaderMap,
    State(state): State<SecureState>,
    envelope: axum::body::Bytes,
) -> axum::response::Response {
    let Some(key_id) = headers
        .get(crate::secure::KEY_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
    else {
        return envelope_error(StatusCode::BAD_REQUEST, "Missing envelope key id");
    };

    let Some((_user, secret)) = state.app.account_manager.session_for_key_id(&key_id) else {
        return envelope_error(StatusCode::UNAUTHORIZED, "Unknown or expired session");
    };
    let keys = crate::secure::derive_keys(&secret, &key_id);

    let (seq, ciphertext) = match crate::secure::split_sequence(&envelope) {
        Ok(parts) => parts,
        Err(message) => return envelope_error(StatusCode::BAD_REQUEST, &message),
    };

    let (request_header, body) = match crate::secure::open_request(&keys, &key_id, seq, ciphertext) {
        Ok(opened) => opened,
        Err(message) => return envelope_error(StatusCode::UNAUTHORIZED, &message),
    };

    // Replay is checked after decryption so a rejected sequence can be reported inside the
    // envelope, letting the client resynchronise after a restart.
    if let Err(next_seq) = state.app.account_manager.accept_sequence(&key_id, seq) {
        let body = serde_json::to_vec(&serde_json::json!({
            "success": false,
            "message": "Envelope sequence number was replayed or is stale",
            "next_seq": next_seq,
        }))
        .unwrap_or_default();
        return seal_or_error(&keys, &key_id, seq, StatusCode::CONFLICT, &body);
    }

    let mut uri = request_header.path.clone();
    if !request_header.query.is_empty() {
        let query: Vec<String> = request_header
            .query
            .iter()
            .map(|(key, value)| {
                format!(
                    "{}={}",
                    urlencode(key),
                    urlencode(value)
                )
            })
            .collect();
        uri = format!("{}?{}", uri, query.join("&"));
    }

    let mut builder = axum::http::Request::builder()
        .method(request_header.method.as_str())
        .uri(&uri);
    for (name, value) in &request_header.headers {
        // The envelope authenticates the caller; an inner Authorization header would be
        // attacker-controlled, so it is replaced below rather than forwarded.
        if name.eq_ignore_ascii_case("authorization") {
            continue;
        }
        builder = builder.header(name, value);
    }
    let inner_request = match builder
        .header("authorization", format!("Bearer {}", secret))
        .body(axum::body::Body::from(body))
    {
        Ok(request) => request,
        Err(_) => return envelope_error(StatusCode::BAD_REQUEST, "Malformed inner request"),
    };

    let response = match tower::ServiceExt::oneshot(state.inner.clone(), inner_request).await {
        Ok(response) => response,
        Err(_) => return envelope_error(StatusCode::INTERNAL_SERVER_ERROR, "Inner dispatch failed"),
    };

    let status = response.status();
    let response_headers: std::collections::BTreeMap<String, String> = response
        .headers()
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect();

    let body = match axum::body::to_bytes(response.into_body(), 32 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => return envelope_error(StatusCode::INTERNAL_SERVER_ERROR, "Inner response too large"),
    };

    let header = crate::secure::SecureResponseHeader {
        status: status.as_u16(),
        headers: response_headers,
    };
    match crate::secure::seal_response(&keys, &key_id, seq, &header, &body) {
        Ok(sealed) => sealed.into_response(),
        Err(message) => envelope_error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

fn seal_or_error(
    keys: &crate::secure::SessionKeys,
    key_id: &str,
    seq: u64,
    status: StatusCode,
    body: &[u8],
) -> axum::response::Response {
    let header = crate::secure::SecureResponseHeader {
        status: status.as_u16(),
        headers: std::collections::BTreeMap::from([(
            "content-type".to_string(),
            "application/json".to_string(),
        )]),
    };
    match crate::secure::seal_response(keys, key_id, seq, &header, body) {
        Ok(sealed) => sealed.into_response(),
        Err(message) => envelope_error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{:02X}", byte),
        })
        .collect()
}

// ==========================================
// Helper functions
// ==========================================

async fn health_check() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

#[derive(Serialize)]
pub struct SessionResponse {
    pub user: String,
}

/// Confirms an access token is valid for this instance, letting a client check a stored token
/// before committing to the LAN transport.
async fn describe_session(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<SessionResponse>>, (StatusCode, Json<ApiResponse<()>>)> {
    let user = get_request_user(&headers, None, None, &state.account_manager)?;
    Ok(Json(ApiResponse {
        success: true,
        message: "Session is valid".to_string(),
        data: Some(SessionResponse { user }),
    }))
}

async fn logout(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    get_request_user(&headers, None, None, &state.account_manager)?;
    if let Some(token) = bearer_token(&headers) {
        state.account_manager.revoke_token(token);
    }
    Ok(Json(ApiResponse {
        success: true,
        message: "Signed out".to_string(),
        data: None,
    }))
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .map(|value| value.trim().trim_start_matches("Bearer ").trim())
        .filter(|token| !token.is_empty())
}

/// Extracts active user from headers, query parameters, or an auth token.
fn get_request_user(
    headers: &HeaderMap,
    _user_param: Option<&str>,
    token_param: Option<&str>,
    account_manager: &AccountManager,
) -> Result<String, (StatusCode, Json<ApiResponse<()>>)> {
    if let Some(token) = headers.get("Authorization").and_then(|v| v.to_str().ok()) {
        let token = token.trim().trim_start_matches("Bearer ");
        if let Some(user) = account_manager.authenticate_token(token) {
            return Ok(user);
        }
    }
    if let Some(token) = token_param {
        if !token.trim().is_empty() {
            if let Some(user) = account_manager.authenticate_token(token) {
                return Ok(user);
            }
        }
    }
    Err((
        StatusCode::UNAUTHORIZED,
        Json(ApiResponse {
            success: false,
            message: "Missing or invalid authentication context. Supply an Authorization bearer token or a 'token' parameter.".to_string(),
            data: None,
        }),
    ))
}

pub(crate) fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "vcf" => "text/vcard; charset=utf-8",
        "json" => "application/json",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::RootDir => {
                normalized.push("/");
            }
            Component::Prefix(prefix) => {
                normalized.push(prefix.as_os_str());
            }
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(part) => {
                normalized.push(part);
            }
        }
    }

    normalized
}

fn is_path_within(path: &Path, root: &Path) -> bool {
    let normalized_path = normalize_path(path);
    let normalized_root = normalize_path(root);

    if normalized_path == normalized_root {
        return true;
    }

    normalized_path.starts_with(&normalized_root)
}

fn resolve_path_with_missing_tail(path: &Path) -> Option<PathBuf> {
    let mut missing = Vec::new();
    let mut existing = path;
    while !existing.exists() {
        missing.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?;
    }

    let mut resolved = fs::canonicalize(existing).ok()?;
    for component in missing.iter().rev() {
        resolved.push(component);
    }
    Some(resolved)
}

/// Helper to check path safety (only let users touch files inside their workspace or shared with them)
fn check_path_write_permission(user: &str, target_path: &Path, data_dir: &str) -> bool {
    let data_root = Path::new(data_dir);
    let allowed_prefixes = [data_root.join(user), data_root.join("users").join(user)];
    let Some(resolved_target) = resolve_path_with_missing_tail(target_path) else {
        return false;
    };
    allowed_prefixes.iter().any(|prefix| {
        resolve_path_with_missing_tail(prefix)
            .map(|resolved_prefix| is_path_within(&resolved_target, &resolved_prefix))
            .unwrap_or(false)
    })
}
// ==========================================
// Handlers
// ==========================================

async fn list_mounts(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Json<Vec<MountInfo>>, (StatusCode, Json<ApiResponse<()>>)> {
    let _ = get_request_user(&headers, None, None, &state.account_manager)?;
    match StorageManager::list_mounts() {
        Ok(mounts) => Ok(Json(mounts)),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Mount list scan failed: {}", e),
                data: None,
            }),
        )),
    }
}

async fn scan_directory(
    headers: HeaderMap,
    Query(params): Query<ScanQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<Vec<StorageInfo>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        None,
        &state.account_manager,
    )?;

    // Verify directory security boundary
    let target = Path::new(&params.path);
    let config = state.config_manager.get_config();
    let workspace_root = Path::new(&config.data_dir).join(&requesting_user);
    let legacy_workspace_root = Path::new(&config.data_dir)
        .join("users")
        .join(&requesting_user);

    let allowed_roots = config
        .scan_dirs
        .iter()
        .map(PathBuf::from)
        .chain([workspace_root, legacy_workspace_root]);
    let target_allowed = allowed_roots.into_iter().any(|root| {
        resolve_path_with_missing_tail(target)
            .zip(resolve_path_with_missing_tail(&root))
            .map(|(resolved_target, resolved_root)| {
                is_path_within(&resolved_target, &resolved_root)
            })
            .unwrap_or(false)
    });

    if !target_allowed {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Directory is outside configured scan roots and your workspace"
                    .to_string(),
                data: None,
            }),
        ));
    }

    match StorageManager::scan_directory(&params.path) {
        Ok(info) => Ok(Json(info)),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: format!("Directory scan failed: {}", e),
                data: None,
            }),
        )),
    }
}

async fn mount_device(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<MountRequest>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        payload.user.as_deref(),
        None,
        &state.account_manager,
    )?;
    if !state.account_manager.is_admin(&requesting_user) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Only 'admin' can mount devices".to_string(),
                data: None,
            }),
        ));
    }

    match StorageManager::mount_device(
        &payload.source,
        &payload.target,
        payload.fs_type.as_deref(),
        payload.options.as_deref(),
    ) {
        Ok(_) => Ok(Json(ApiResponse {
            success: true,
            message: "Device mounted successfully".to_string(),
            data: None,
        })),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Mount failed: {}", e),
                data: None,
            }),
        )),
    }
}

async fn umount_device(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<UmountRequest>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        payload.user.as_deref(),
        None,
        &state.account_manager,
    )?;
    if !state.account_manager.is_admin(&requesting_user) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Only 'admin' can unmount devices".to_string(),
                data: None,
            }),
        ));
    }

    match StorageManager::umount(&payload.target) {
        Ok(_) => Ok(Json(ApiResponse {
            success: true,
            message: "Device unmounted successfully".to_string(),
            data: None,
        })),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Umount failed: {}", e),
                data: None,
            }),
        )),
    }
}

async fn upload_file(
    headers: HeaderMap,
    State(state): State<AppState>,
    Query(params): Query<UploadQueryParams>,
    mut multipart: Multipart,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        params.token.as_deref(),
        &state.account_manager,
    )
    .map_err(|(status, Json(response))| {
        (
            status,
            Json(ApiResponse::<String> {
                success: response.success,
                message: response.message,
                data: None,
            }),
        )
    })?;
    let config = state.config_manager.get_config();

    let mut resolved_path = params.path.map(PathBuf::from);

    while let Some(field) = multipart.next_field().await.map_err(|e| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: format!("Multipart decoding error: {}", e),
                data: None,
            }),
        )
    })? {
        let file_name = field.file_name().unwrap_or("").to_string();
        let data = field.bytes().await.map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    success: false,
                    message: format!("Failed to read multipart bytes: {}", e),
                    data: None,
                }),
            )
        })?;

        // Default to a per-account workspace layout while honoring an SDK directory when supplied.
        let requested_path = resolved_path.take();
        if requested_path
            .as_ref()
            .map(|path| path.components().count() <= 1)
            .unwrap_or(true)
        {
            let final_name = if file_name.is_empty() {
                "uploaded_file.bin".to_string()
            } else {
                file_name
            };

            let lower_name = final_name.to_lowercase();
            let category = if ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"]
                .iter()
                .any(|ext| lower_name.ends_with(ext))
            {
                "Photos"
            } else if ["txt", "md", "json", "csv", "yaml", "yml", "xml"]
                .iter()
                .any(|ext| lower_name.ends_with(ext))
            {
                "Documents"
            } else {
                "Files"
            };

            resolved_path = Some(
                Path::new(&config.data_dir)
                    .join(&requesting_user)
                    .join(category)
                    .join(final_name),
            );
        } else if let Some(requested_path) = requested_path {
            let relative_path = requested_path.strip_prefix("/").unwrap_or(&requested_path);
            resolved_path = Some(
                Path::new(&config.data_dir)
                    .join(&requesting_user)
                    .join(relative_path),
            );
        }

        if let Some(ref target) = resolved_path {
            // Verify path permission boundary
            if !check_path_write_permission(&requesting_user, target, &config.data_dir) {
                return Err((
                    StatusCode::FORBIDDEN,
                    Json(ApiResponse {
                        success: false,
                        message: format!(
                            "Forbidden: Cannot write outside your workspace folder {:?}",
                            target
                        ),
                        data: None,
                    }),
                ));
            }

            match FileManager::save_and_index_file(
                &data,
                target,
                &state.search_manager,
                Some(&state.share_registry),
            ) {
                Ok(_) => {
                    let path_str = target.to_string_lossy().to_string();
                    return Ok(Json(ApiResponse {
                        success: true,
                        message:
                            "File successfully uploaded, indexed, and restricted to your space"
                                .to_string(),
                        data: Some(path_str),
                    }));
                }
                Err(e) => {
                    return Err((
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiResponse {
                            success: false,
                            message: format!("Upload failed: {}", e),
                            data: None,
                        }),
                    ));
                }
            }
        }
    }

    Err((
        StatusCode::BAD_REQUEST,
        Json(ApiResponse {
            success: false,
            message: "No file field found in form data".to_string(),
            data: None,
        }),
    ))
}

async fn download_file(
    headers: HeaderMap,
    Query(params): Query<FileQueryParams>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        None,
        &state.account_manager,
    )?;
    let path = Path::new(&params.path);

    if !path.exists() {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                success: false,
                message: "Target file does not exist".to_string(),
                data: None,
            }),
        ));
    }

    // Verify sharing permission or ownership
    if !state
        .share_registry
        .check_access(&requesting_user, &params.path)
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Access Denied: You do not have permissions to download this file"
                    .to_string(),
                data: None,
            }),
        ));
    }

    let bytes = fs::read(path).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to read file: {}", e),
                data: None,
            }),
        )
    })?;

    let mime = guess_mime(path);

    Ok(axum::response::Response::builder()
        .header("Content-Type", mime)
        .header(
            "Content-Disposition",
            format!(
                "attachment; filename=\"{}\"",
                path.file_name().and_then(|n| n.to_str()).unwrap_or("file")
            ),
        )
        .body(axum::body::Body::from(bytes))
        .unwrap())
}

async fn list_files(
    headers: HeaderMap,
    Query(params): Query<ListQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<crate::files::DirectoryListing>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, None, None, &state.account_manager)?;
    let config = state.config_manager.get_config();
    let workspace_root = Path::new(&config.data_dir).join(&requesting_user);

    match FileManager::list_directory(
        &workspace_root,
        params.path.as_deref().unwrap_or("/"),
        params.recursive.unwrap_or(false),
        params.limit.unwrap_or(crate::files::MAX_LIST_ENTRIES),
    ) {
        Ok(listing) => Ok(Json(ApiResponse {
            success: true,
            message: format!("{} entries", listing.entries.len()),
            data: Some(listing),
        })),
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: e,
                data: None,
            }),
        )),
    }
}

async fn delete_file(
    headers: HeaderMap,
    Query(params): Query<FileQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        None,
        &state.account_manager,
    )?;
    let path = Path::new(&params.path);

    // Extract file owner to verify delete permissions
    let _path_str = path.to_string_lossy();

    // Quick helper lookup
    let is_owner = check_path_write_permission(
        &requesting_user,
        path,
        &state.config_manager.get_config().data_dir,
    );

    if !is_owner && !state.account_manager.is_admin(&requesting_user) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Only the owner (or admin) can delete this file".to_string(),
                data: None,
            }),
        ));
    }

    match FileManager::delete_file(path, &state.search_manager) {
        Ok(_) => {
            state
                .share_registry
                .remove_deleted_file(&params.path)
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ApiResponse {
                            success: false,
                            message: e,
                            data: None,
                        }),
                    )
                })?;
            Ok(Json(ApiResponse {
                success: true,
                message: "File successfully deleted and removed from search index".to_string(),
                data: None,
            }))
        }
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to delete file: {}", e),
                data: None,
            }),
        )),
    }
}

async fn search_index(
    headers: HeaderMap,
    Query(params): Query<SearchQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<Vec<SearchResult>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        None,
        &state.account_manager,
    )?;
    let limit = params.limit.unwrap_or(20);

    match state
        .search_manager
        .search(&params.q, &requesting_user, limit)
    {
        Ok(results) => Ok(Json(results)),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Search execution failed: {}", e),
                data: None,
            }),
        )),
    }
}

// ==========================================
// Sharing Handlers
// ==========================================

async fn faces_endpoint(
    headers: HeaderMap,
    method: axum::http::Method,
    uri: axum::http::Uri,
    Query(query): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let user = match get_request_user(&headers, None, None, &state.account_manager) {
        Ok(user) => user,
        Err(error) => return error.into_response(),
    };
    let body = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(value) => value,
            Err(_) => return envelope_error(StatusCode::BAD_REQUEST, "Request body must be JSON"),
        }
    };
    let data_dir = state.config_manager.get_config().data_dir;
    let faces = state.search_manager.faces().clone();
    let path = uri.path().to_string();
    let result = tokio::task::spawn_blocking(move || {
        crate::faces::handle_request(
            &faces,
            &data_dir,
            &user,
            method.as_str(),
            &path,
            &query,
            &body,
        )
    })
    .await;
    match result {
        Ok((status, value)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            Json(value),
        )
            .into_response(),
        Err(_) => envelope_error(StatusCode::INTERNAL_SERVER_ERROR, "Face request failed"),
    }
}

// ==========================================
// Sharing Handlers
// ==========================================

async fn share_file(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<ShareRequest>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, None, None, &state.account_manager)?;
    let config = state.config_manager.get_config();
    if !Path::new(&payload.file_path).exists()
        || !check_path_write_permission(
            &requesting_user,
            Path::new(&payload.file_path),
            &config.data_dir,
        )
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Only files in your own workspace can be shared".to_string(),
                data: None,
            }),
        ));
    }

    match state
        .share_registry
        .add_share(&requesting_user, &payload.file_path, payload.shared_with)
    {
        Ok(_) => {
            let path = Path::new(&payload.file_path);
            FileManager::process_and_index_file(
                path,
                &state.search_manager,
                Some(&state.share_registry),
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse {
                        success: false,
                        message: e,
                        data: None,
                    }),
                )
            })?;

            Ok(Json(ApiResponse {
                success: true,
                message: "File successfully shared".to_string(),
                data: None,
            }))
        }
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to share file: {}", e),
                data: None,
            }),
        )),
    }
}

async fn unshare_file(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<UnshareRequest>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, None, None, &state.account_manager)?;

    match state.share_registry.remove_share(
        &requesting_user,
        &payload.file_path,
        &payload.user_to_remove,
    ) {
        Ok(_) => {
            let path = Path::new(&payload.file_path);
            FileManager::process_and_index_file(
                path,
                &state.search_manager,
                Some(&state.share_registry),
            )
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ApiResponse {
                        success: false,
                        message: e,
                        data: None,
                    }),
                )
            })?;

            Ok(Json(ApiResponse {
                success: true,
                message: "File sharing permissions updated".to_string(),
                data: None,
            }))
        }
        Err(e) => Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to update sharing permissions: {}", e),
                data: None,
            }),
        )),
    }
}

async fn list_shares(
    headers: HeaderMap,
    Query(params): Query<UploadQueryParams>, // Just fetch user
    State(state): State<AppState>,
) -> Result<Json<ShareListResponse>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(
        &headers,
        params.user.as_deref(),
        params.token.as_deref(),
        &state.account_manager,
    )?;

    let owned_shares = state.share_registry.get_shares_by_owner(&requesting_user);
    let shared_with_me = state.share_registry.get_shares_for_user(&requesting_user);

    Ok(Json(ShareListResponse {
        owned_shares,
        shared_with_me,
    }))
}

// ==========================================
// Admin dashboard handlers
// ==========================================

/// Requests proxied through Home Assistant's Ingress carry this header (added by the Supervisor
/// and stripped from any request that didn't come through it), meaning the caller is already an
/// authenticated, logged-in HA user, so the dashboard can be trusted without a bearer token.
fn is_ingress_request(headers: &HeaderMap) -> bool {
    headers.contains_key("x-ingress-path")
}

async fn require_admin(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<String, (StatusCode, Json<ApiResponse<()>>)> {
    if is_ingress_request(headers) {
        return Ok("ingress".to_string());
    }
    return Err((
        StatusCode::FORBIDDEN,
        Json(ApiResponse {
            success: false,
            message: "The dashboard can only be accessed through Home Assistant".to_string(),
            data: None,
        }),
    ));
}

/// Recursively sums the size of all files under `path`, skipping entries it cannot read.
fn dir_size(path: &Path) -> u64 {
    let Ok(read_dir) = fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in read_dir.flatten() {
        let entry_path = entry.path();
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_dir() {
                total += dir_size(&entry_path);
            } else {
                total += metadata.len();
            }
        }
    }
    total
}

fn top_level_folder_usage(workspace_root: &Path) -> Vec<serde_json::Value> {
    let Ok(read_dir) = fs::read_dir(workspace_root) else {
        return Vec::new();
    };
    let mut categories: Vec<_> = read_dir
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            path.is_dir().then(|| {
                serde_json::json!({
                    "name": entry.file_name().to_string_lossy(),
                    "storage_bytes": dir_size(&path),
                })
            })
        })
        .collect();
    categories.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    categories
}

fn attach_instance_metadata(
    body: &mut serde_json::Value,
    bridge_connected: bool,
    State(state): State<AppState>,
) {
    if body.get("success") != Some(&serde_json::Value::Bool(true)) {
        return;
    }

    let config = state.config_manager.get_config();

    let disk_space = StorageManager::get_disk_space(&config.data_dir).ok();
    let total_storage_bytes = disk_space
        .as_ref()
        .map(|space| space.total_bytes)
        .unwrap_or(0);
    let used_storage_bytes = disk_space
        .as_ref()
        .map(|space| space.used_bytes)
        .unwrap_or(0);
    let available_storage_bytes = disk_space
        .as_ref()
        .map(|space| space.available_bytes)
        .unwrap_or(0);

    let Some(data) = body.get_mut("data") else {
        let mut data_obj = serde_json::Map::new();
        data_obj.insert(
            "bridge_connected".to_string(),
            serde_json::Value::Bool(bridge_connected),
        );
        data_obj.insert(
            "total_storage_bytes".to_string(),
            serde_json::Value::Number(total_storage_bytes.into()),
        );
        data_obj.insert(
            "used_storage_bytes".to_string(),
            serde_json::Value::Number(used_storage_bytes.into()),
        );
        data_obj.insert(
            "available_storage_bytes".to_string(),
            serde_json::Value::Number(available_storage_bytes.into()),
        );
        body["data"] = serde_json::Value::Object(data_obj);
        return;
    };

    if let Some(obj) = data.as_object_mut() {
        obj.insert(
            "bridge_connected".to_string(),
            serde_json::Value::Bool(bridge_connected),
        );
        obj.insert(
            "data_dir".to_string(),
            serde_json::Value::String(config.data_dir.clone()),
        );
        obj.insert(
            "storage_roots".to_string(),
            serde_json::Value::Array(
                storage_roots()
                    .into_iter()
                    .map(|path| serde_json::Value::String(path.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        obj.insert(
            "total_storage_bytes".to_string(),
            serde_json::Value::Number(total_storage_bytes.into()),
        );
        obj.insert(
            "used_storage_bytes".to_string(),
            serde_json::Value::Number(used_storage_bytes.into()),
        );
        obj.insert(
            "available_storage_bytes".to_string(),
            serde_json::Value::Number(available_storage_bytes.into()),
        );
    }

    //for each user (in data->members), work out storage used:
    if let Some(obj) = data.as_object_mut() {
        if let Some(members) = obj.get_mut("members") {
            if let Some(members_array) = members.as_array_mut() {
                for member in members_array {
                    if let Some(member_obj) = member.as_object_mut() {
                        if let Some(username) = member_obj.get("email").and_then(|v| v.as_str()) {
                            let normalized_user =
                                crate::auth::AccountManager::normalize_username(username);
                            let workspace_root =
                                resolve_user_workspace_root(&config.data_dir, &normalized_user);
                            let storage_bytes = workspace_root
                                .as_ref()
                                .map(|root| dir_size(root))
                                .unwrap_or(0);
                            let storage_categories = workspace_root
                                .as_ref()
                                .map(|root| top_level_folder_usage(root))
                                .unwrap_or_default();
                            member_obj.insert(
                                "storage_bytes".to_string(),
                                serde_json::Value::Number(storage_bytes.into()),
                            );
                            member_obj.insert(
                                "storage_categories".to_string(),
                                serde_json::Value::Array(storage_categories),
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Resolves a user's workspace root, preferring the current layout over the legacy `users/` one.
fn resolve_user_workspace_root(data_dir: &str, user: &str) -> Option<PathBuf> {
    let data_root = Path::new(data_dir);
    for candidate in [data_root.join(user), data_root.join("users").join(user)] {
        if candidate.is_dir() {
            return Some(candidate);
        }
    }
    None
}

async fn browse_user_files(
    headers: HeaderMap,
    Query(params): Query<BrowseQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<BrowseResponse>, (StatusCode, Json<ApiResponse<()>>)> {
    require_admin(&headers, &state).await?;

    let config = state.config_manager.get_config();
    let normalized_user = crate::auth::AccountManager::normalize_username(&params.user);
    let Some(workspace_root) = resolve_user_workspace_root(&config.data_dir, &normalized_user)
    else {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ApiResponse {
                success: false,
                message: format!("No workspace found for user '{}'", normalized_user),
                data: None,
            }),
        ));
    };

    let relative_path = params.path.unwrap_or_default();
    let requested_dir = normalize_path(&workspace_root.join(&relative_path));

    let resolved_root = fs::canonicalize(&workspace_root).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to resolve workspace root: {}", e),
                data: None,
            }),
        )
    })?;
    let Some(resolved_target) = resolve_path_with_missing_tail(&requested_dir) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: "Requested path could not be resolved".to_string(),
                data: None,
            }),
        ));
    };

    if !is_path_within(&resolved_target, &resolved_root) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Requested path is outside of the user's workspace".to_string(),
                data: None,
            }),
        ));
    }

    if !resolved_target.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message: "Requested path is not a directory".to_string(),
                data: None,
            }),
        ));
    }

    let read_dir = fs::read_dir(&resolved_target).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to read directory: {}", e),
                data: None,
            }),
        )
    })?;

    let mut entries = Vec::new();
    for entry in read_dir.flatten() {
        let entry_path = entry.path();
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_relative = entry_path
            .strip_prefix(&resolved_root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        let modified_at = metadata
            .modified()
            .ok()
            .map(chrono::DateTime::<chrono::Utc>::from)
            .map(|dt| dt.to_rfc3339());

        entries.push(BrowseEntry {
            name,
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified_at,
            relative_path: entry_relative,
        });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));

    Ok(Json(BrowseResponse {
        user: normalized_user,
        relative_path,
        entries,
    }))
}

// ==========================================
// Cloud instance management (name + members), proxied via this instance's own tunnel token
// ==========================================

#[derive(Deserialize)]
pub struct RenameInstanceRequest {
    pub label: String,
}

#[derive(Deserialize)]
pub struct InviteMemberRequest {
    pub email: String,
}

#[derive(Deserialize)]
pub struct ChangeStorageRequest {
    pub path: String,
}

fn storage_roots() -> Vec<PathBuf> {
    ["/config", "/share", "/media"]
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect()
}

fn ensure_storage_target_empty(target: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if !target.is_dir() {
        return Err("The selected storage location is not a directory".to_string());
    }
    let mut entries = fs::read_dir(target)
        .map_err(|e| format!("Failed to read the selected storage location: {}", e))?;
    if entries.next().is_some() {
        return Err("The selected storage location must be empty".to_string());
    }
    Ok(())
}

fn validate_storage_target(path: &str, current: &Path) -> Result<PathBuf, String> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err("Storage location must be an absolute path".to_string());
    }

    let target = resolve_path_with_missing_tail(&target)
        .ok_or_else(|| "Storage location could not be resolved".to_string())?;
    let allowed = storage_roots().into_iter().any(|root| {
        resolve_path_with_missing_tail(&root)
            .map(|resolved_root| is_path_within(&target, &resolved_root))
            .unwrap_or(false)
    });
    if !allowed {
        return Err("Storage location must be inside /config, /share, or /media".to_string());
    }

    let current = fs::canonicalize(current)
        .map_err(|e| format!("Failed to resolve current storage location: {}", e))?;
    if target == current {
        return Err("The selected location is already in use".to_string());
    }
    if is_path_within(&target, &current) || is_path_within(&current, &target) {
        return Err(
            "The new storage location cannot contain, or be inside, the current location"
                .to_string(),
        );
    }
    ensure_storage_target_empty(&target)?;
    Ok(target)
}

fn copy_directory(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|e| format!("Failed to create {}: {}", target.display(), e))?;
    for entry in
        fs::read_dir(source).map_err(|e| format!("Failed to read {}: {}", source.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect {}: {}", source_path.display(), e))?;
        if file_type.is_dir() {
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path)
                .map_err(|e| format!("Failed to copy {}: {}", source_path.display(), e))?;
        } else if file_type.is_symlink() {
            let link_target = fs::read_link(&source_path)
                .map_err(|e| format!("Failed to read link {}: {}", source_path.display(), e))?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link_target, &target_path)
                .map_err(|e| format!("Failed to copy link {}: {}", source_path.display(), e))?;
            #[cfg(not(unix))]
            return Err(format!(
                "Symbolic links are not supported at {}",
                source_path.display()
            ));
        } else {
            return Err(format!(
                "Unsupported file type at {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

fn move_directory(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        fs::remove_dir(target)
            .map_err(|e| format!("Failed to prepare the selected storage location: {}", e))?;
    }
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }

    if let Err(err) = copy_directory(source, target) {
        let _ = fs::remove_dir_all(target);
        return Err(err);
    }
    fs::remove_dir_all(source).map_err(|e| {
        format!(
            "Files were copied, but the old storage location could not be removed: {}",
            e
        )
    })
}

async fn change_storage_location(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<ChangeStorageRequest>,
) -> Result<Json<ApiResponse<serde_json::Value>>, (StatusCode, Json<ApiResponse<serde_json::Value>>)>
{
    require_admin(&headers, &state)
        .await
        .map_err(|(status, Json(response))| {
            (
                status,
                Json(ApiResponse {
                    success: response.success,
                    message: response.message,
                    data: None,
                }),
            )
        })?;

    let old_config = state.config_manager.get_config();
    let source = PathBuf::from(&old_config.data_dir);
    let target = validate_storage_target(&payload.path, &source).map_err(|message| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiResponse {
                success: false,
                message,
                data: None,
            }),
        )
    })?;

    move_directory(&source, &target).map_err(|message| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message,
                data: None,
            }),
        )
    })?;

    let mut new_config = old_config.clone();
    new_config.data_dir = target.to_string_lossy().into_owned();
    if let Err(message) = state.config_manager.update_config(new_config) {
        let rollback = move_directory(&target, &source);
        let message = match rollback {
            Ok(()) => format!("Failed to save the new storage location: {}", message),
            Err(rollback_error) => format!(
                "Failed to save the new storage location: {}. Rollback also failed: {}",
                message, rollback_error
            ),
        };
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message,
                data: None,
            }),
        ));
    }

    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_millis(750)).await;
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            if let Ok(executable) = std::env::current_exe() {
                let error = std::process::Command::new(executable).exec();
                tracing::error!("Failed to restart Flux after storage migration: {}", error);
            }
        }
        std::process::exit(1);
    });

    Ok(Json(ApiResponse {
        success: true,
        message: "Storage moved successfully. Flux is restarting.".to_string(),
        data: Some(serde_json::json!({ "path": target })),
    }))
}

/// Reads this instance's cloud relay credentials, or an error response if not yet registered.
fn cloud_credentials(
    state: &AppState,
) -> Result<(String, String), (StatusCode, Json<ApiResponse<()>>)> {
    let config = state.config_manager.get_config();
    let instance_id = config.instance_id.filter(|v| !v.trim().is_empty());
    let token = config.websocket_token.filter(|v| !v.trim().is_empty());
    match (instance_id, token) {
        (Some(instance_id), Some(token)) => Ok((instance_id, token)),
        _ => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiResponse {
                success: false,
                message: "Cloud relay is not configured for this instance yet".to_string(),
                data: None,
            }),
        )),
    }
}

fn cloud_unreachable(e: reqwest::Error) -> (StatusCode, Json<ApiResponse<()>>) {
    warn!("Cloud relay request failed: {}", e);
    (
        StatusCode::BAD_GATEWAY,
        Json(ApiResponse {
            success: false,
            message: format!("Failed to reach cloud relay: {}", e),
            data: None,
        }),
    )
}

/// Passes a cloud relay JSON response straight through, preserving its status code and body.
async fn forward_cloud_json(resp: reqwest::Response) -> axum::response::Response {
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    match resp.json::<serde_json::Value>().await {
        Ok(body) => (status, Json(body)).into_response(),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiResponse::<()> {
                success: false,
                message: "Invalid response from cloud relay".to_string(),
                data: None,
            }),
        )
            .into_response(),
    }
}

async fn get_instance_info(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> axum::response::Response {
    if let Err(err) = require_admin(&headers, &state).await {
        return err.into_response();
    }
    let (instance_id, token) = match cloud_credentials(&state) {
        Ok(v) => v,
        Err(err) => return err.into_response(),
    };

    let client = reqwest::Client::new();
    let bridge_connected = state.bridge_connected.load(Ordering::SeqCst);
    let url = format!(
        "{}/api/instances/{}",
        crate::definitions::CLOUD_URL,
        instance_id
    );

    match client.get(&url).bearer_auth(&token).send().await {
        Ok(resp) => {
            let status =
                StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            match resp.json::<serde_json::Value>().await {
                Ok(mut body) => {
                    attach_instance_metadata(&mut body, bridge_connected, State(state.clone()));
                    (status, Json(body)).into_response()
                }
                Err(_) => (
                    StatusCode::BAD_GATEWAY,
                    Json(ApiResponse::<()> {
                        success: false,
                        message: "Invalid response from cloud relay".to_string(),
                        data: None,
                    }),
                )
                    .into_response(),
            }
        }
        Err(e) => cloud_unreachable(e).into_response(),
    }
}

async fn rename_instance(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<RenameInstanceRequest>,
) -> axum::response::Response {
    if let Err(err) = require_admin(&headers, &state).await {
        return err.into_response();
    }
    let (instance_id, token) = match cloud_credentials(&state) {
        Ok(v) => v,
        Err(err) => return err.into_response(),
    };

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/instances/{}/label",
        crate::definitions::CLOUD_URL,
        instance_id
    );
    match client
        .put(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "label": payload.label }))
        .send()
        .await
    {
        Ok(resp) => forward_cloud_json(resp).await,
        Err(e) => cloud_unreachable(e).into_response(),
    }
}

async fn invite_instance_member(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<InviteMemberRequest>,
) -> axum::response::Response {
    if let Err(err) = require_admin(&headers, &state).await {
        return err.into_response();
    }
    let (instance_id, token) = match cloud_credentials(&state) {
        Ok(v) => v,
        Err(err) => return err.into_response(),
    };

    let client = reqwest::Client::new();
    let url = format!(
        "{}/api/instances/{}/members",
        crate::definitions::CLOUD_URL,
        instance_id
    );
    match client
        .post(&url)
        .bearer_auth(&token)
        .json(&serde_json::json!({ "email": payload.email }))
        .send()
        .await
    {
        Ok(resp) => forward_cloud_json(resp).await,
        Err(e) => cloud_unreachable(e).into_response(),
    }
}

async fn serve_admin_ui(headers: HeaderMap) -> Result<Html<&'static str>, StatusCode> {
    // Only reachable through Home Assistant's Ingress proxy, not directly over the exposed port.
    if !is_ingress_request(&headers) {
        return Err(StatusCode::NOT_FOUND);
    }
    Ok(Html(include_str!("static/admin.html")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn move_directory_moves_nested_files_and_removes_source() {
        let temp_dir = tempfile::tempdir().unwrap();
        let source = temp_dir.path().join("old");
        let target = temp_dir.path().join("new");
        std::fs::create_dir_all(source.join("alice/Photos")).unwrap();
        std::fs::write(source.join("alice/Photos/photo.jpg"), b"photo").unwrap();

        move_directory(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(target.join("alice/Photos/photo.jpg")).unwrap(),
            b"photo"
        );
    }

    #[test]
    fn validate_storage_target_rejects_non_empty_destination() {
        let destination = tempfile::tempdir_in("/tmp").unwrap();
        std::fs::write(destination.path().join("existing.txt"), b"existing").unwrap();

        let result = ensure_storage_target_empty(destination.path());

        assert_eq!(
            result.unwrap_err(),
            "The selected storage location must be empty"
        );
    }

    #[test]
    fn top_level_folder_usage_reports_sorted_recursive_totals() {
        let temp_dir = tempfile::tempdir().unwrap();
        let workspace = temp_dir.path().join("alice");
        std::fs::create_dir_all(workspace.join("Photos/Trips")).unwrap();
        std::fs::create_dir_all(workspace.join("Notes")).unwrap();
        std::fs::write(workspace.join("Photos/Trips/photo.jpg"), b"12345").unwrap();
        std::fs::write(workspace.join("Notes/note.md"), b"123").unwrap();
        std::fs::write(workspace.join("loose.txt"), b"not a category").unwrap();

        assert_eq!(
            top_level_folder_usage(&workspace),
            vec![
                serde_json::json!({ "name": "Notes", "storage_bytes": 3 }),
                serde_json::json!({ "name": "Photos", "storage_bytes": 5 }),
            ]
        );
    }

    #[test]
    fn test_path_permissions_respect_workspace_boundaries() {
        let temp_dir = tempfile::tempdir().unwrap();
        let data_dir = temp_dir.path().to_str().unwrap();
        std::fs::create_dir_all(temp_dir.path().join("alice/Photos")).unwrap();
        std::fs::create_dir_all(temp_dir.path().join("users/alice/Documents")).unwrap();

        assert!(check_path_write_permission(
            "alice",
            &temp_dir.path().join("alice/Photos/photo.jpg"),
            data_dir,
        ));
        assert!(check_path_write_permission(
            "alice",
            &temp_dir.path().join("users/alice/Documents/note.txt"),
            data_dir,
        ));
        assert!(!check_path_write_permission(
            "alice",
            &temp_dir.path().join("bob/Photos/photo.jpg"),
            data_dir,
        ));
        assert!(!check_path_write_permission(
            "alice",
            Path::new("/tmp/other/photo.jpg"),
            data_dir,
        ));
        assert!(!check_path_write_permission(
            "alice",
            Path::new("/data/alice/../bob/evil.txt"),
            data_dir,
        ));
        assert!(!check_path_write_permission(
            "alice",
            Path::new("/data/users/alice2/secret.txt"),
            data_dir,
        ));
    }
}
