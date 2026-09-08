use crate::auth::{AccountManager, LoginResponse};
use crate::config::{AppConfig, ConfigManager};
use crate::files::FileManager;
use crate::search::{SearchManager, SearchResult};
use crate::sharing::{Share, ShareRegistry};
use crate::storage::{MountInfo, StorageInfo, StorageManager};
use axum::extract::{Multipart, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tracing::{warn};

#[derive(Clone)]
pub struct AppState {
    pub config_manager: Arc<ConfigManager>,
    pub search_manager: SearchManager,
    pub share_registry: ShareRegistry,
    pub account_manager: AccountManager,
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
pub struct UploadQueryParams {
    pub path: Option<String>,
    pub user: Option<String>,
    pub token: Option<String>,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
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
    axum::Router::new()
        // Config endpoints
        .route("/api/config", get(get_config).post(update_config))
        // Storage endpoints
        .route("/api/storage/mounts", get(list_mounts))
        .route("/api/storage/scan", get(scan_directory))
        .route("/api/storage/mount", post(mount_device))
        .route("/api/storage/umount", post(umount_device))
        // File endpoints
        .route("/api/auth/register", post(register_user))
        .route("/api/auth/login", post(login_user))
        .route("/api/files/upload", post(upload_file))
        .route("/api/files/download", get(download_file))
        .route("/api/files", delete(delete_file))
        // Search endpoint
        .route("/api/search", get(search_index))
        // Share endpoints
        .route("/api/shares/share", post(share_file))
        .route("/api/shares/unshare", post(unshare_file))
        .route("/api/shares/list", get(list_shares))
        .layer(CorsLayer::permissive())
        .layer(RequestBodyLimitLayer::new(25 * 1024 * 1024))
        .with_state(state)
}

// ==========================================
// Helper functions
// ==========================================

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

fn guess_mime(path: &Path) -> &'static str {
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
    let Some(resolved_target) = resolve_path_with_missing_tail(target_path) else { return false; };
    allowed_prefixes.iter().any(|prefix| {
        resolve_path_with_missing_tail(prefix)
            .map(|resolved_prefix| is_path_within(&resolved_target, &resolved_prefix))
            .unwrap_or(false)
    })
}
// ==========================================
// Handlers
// ==========================================

async fn register_user(
    State(state): State<AppState>,
    Json(payload): Json<RegisterRequest>,
) -> Result<Json<ApiResponse<LoginResponse>>, (StatusCode, Json<ApiResponse<()>>)> {
    match state.account_manager.register(&payload.username, &payload.password, payload.display_name, None) {
        Ok(_) => match state.account_manager.login(&payload.username, &payload.password) {
            Ok(session) => Ok(Json(ApiResponse {
                success: true,
                message: "Account created and logged in".to_string(),
                data: Some(session),
            })),
            Err(e) => Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiResponse {
                    success: false,
                    message: format!("Account created but login failed: {}", e),
                    data: None,
                }),
            )),
        },
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

async fn login_user(
    State(state): State<AppState>,
    Json(payload): Json<LoginRequest>,
) -> Result<Json<ApiResponse<LoginResponse>>, (StatusCode, Json<ApiResponse<()>>)> {
    match state.account_manager.login(&payload.username, &payload.password) {
        Ok(session) => Ok(Json(ApiResponse {
            success: true,
            message: "Logged in successfully".to_string(),
            data: Some(session),
        })),
        Err(e) => Err((
            StatusCode::UNAUTHORIZED,
            Json(ApiResponse {
                success: false,
                message: e,
                data: None,
            }),
        )),
    }
}

async fn get_config(
    headers: HeaderMap,
    Query(params): Query<UploadQueryParams>, // Just reuse user extraction
    State(state): State<AppState>,
) -> Result<Json<AppConfig>, (StatusCode, Json<ApiResponse<()>>)> {
    let _ = get_request_user(&headers, params.user.as_deref(), params.token.as_deref(), &state.account_manager)?;
    let mut config = state.config_manager.get_config();
    config.websocket_token = None;
    Ok(Json(config))
}

async fn update_config(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<AppConfig>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, None, None, &state.account_manager)?;
    if !state.account_manager.is_admin(&requesting_user) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Only 'admin' is authorized to update system configurations".to_string(),
                data: None,
            }),
        ));
    }

    match state.config_manager.update_config(payload) {
        Ok(_) => Ok(Json(ApiResponse {
            success: true,
            message: "Configuration updated successfully".to_string(),
            data: None,
        })),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ApiResponse {
                success: false,
                message: format!("Failed to update config: {}", e),
                data: None,
            }),
        )),
    }
}

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
    let requesting_user = get_request_user(&headers, params.user.as_deref(), None, &state.account_manager)?;
    
    // Verify directory security boundary
    let target = Path::new(&params.path);
    let config = state.config_manager.get_config();
    let workspace_root = Path::new(&config.data_dir).join(&requesting_user);
    let legacy_workspace_root = Path::new(&config.data_dir).join("users").join(&requesting_user);

    let allowed_roots = config
        .scan_dirs
        .iter()
        .map(PathBuf::from)
        .chain([workspace_root, legacy_workspace_root]);
    let target_allowed = allowed_roots.into_iter().any(|root| {
        resolve_path_with_missing_tail(target)
            .zip(resolve_path_with_missing_tail(&root))
            .map(|(resolved_target, resolved_root)| is_path_within(&resolved_target, &resolved_root))
            .unwrap_or(false)
    });

    if !target_allowed {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Directory is outside configured scan roots and your workspace".to_string(),
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
    let requesting_user = get_request_user(&headers, payload.user.as_deref(), None, &state.account_manager)?;
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
    let requesting_user = get_request_user(&headers, payload.user.as_deref(), None, &state.account_manager)?;
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
    let requesting_user = get_request_user(&headers, params.user.as_deref(), params.token.as_deref(), &state.account_manager).map_err(|(status, Json(response))| {
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
        if requested_path.as_ref().map(|path| path.components().count() <= 1).unwrap_or(true) {
            let final_name = if file_name.is_empty() {
                "uploaded_file.bin".to_string()
            } else {
                file_name
            };

            let lower_name = final_name.to_lowercase();
            let category = if ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff"].iter().any(|ext| lower_name.ends_with(ext)) {
                "Photos"
            } else if ["txt", "md", "json", "csv", "yaml", "yml", "xml"].iter().any(|ext| lower_name.ends_with(ext)) {
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
                        message: format!("Forbidden: Cannot write outside your workspace folder {:?}", target),
                        data: None,
                    }),
                ));
            }

            match FileManager::save_and_index_file(&data, target, &state.search_manager, Some(&state.share_registry)) {
                Ok(_) => {
                    let path_str = target.to_string_lossy().to_string();
                    return Ok(Json(ApiResponse {
                        success: true,
                        message: "File successfully uploaded, indexed, and restricted to your space".to_string(),
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
    let requesting_user = get_request_user(&headers, params.user.as_deref(), None, &state.account_manager)?;
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
    if !state.share_registry.check_access(&requesting_user, &params.path) {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiResponse {
                success: false,
                message: "Access Denied: You do not have permissions to download this file".to_string(),
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

async fn delete_file(
    headers: HeaderMap,
    Query(params): Query<FileQueryParams>,
    State(state): State<AppState>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, params.user.as_deref(), None, &state.account_manager)?;
    let path = Path::new(&params.path);

    // Extract file owner to verify delete permissions
    let _path_str = path.to_string_lossy();
    
    // Quick helper lookup
    let is_owner = check_path_write_permission(&requesting_user, path, &state.config_manager.get_config().data_dir);

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
            // Also clean up any shares registered
            let _ = state.share_registry.remove_share(&requesting_user, &params.path, "*");
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
    let requesting_user = get_request_user(&headers, params.user.as_deref(), None, &state.account_manager)?;
    let limit = params.limit.unwrap_or(20);

    match state.search_manager.search(&params.q, &requesting_user, limit) {
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

async fn share_file(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(payload): Json<ShareRequest>,
) -> Result<Json<ApiResponse<()>>, (StatusCode, Json<ApiResponse<()>>)> {
    let requesting_user = get_request_user(&headers, None, None, &state.account_manager)?;
    let config = state.config_manager.get_config();
    if !Path::new(&payload.file_path).exists()
        || !check_path_write_permission(&requesting_user, Path::new(&payload.file_path), &config.data_dir)
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

    match state.share_registry.add_share(&requesting_user, &payload.file_path, payload.shared_with) {
        Ok(_) => {
            // Re-index file so Tantivy gets the updated allowed_users list
            let path = Path::new(&payload.file_path);
            if let Err(e) = FileManager::process_and_index_file(path, &state.search_manager, Some(&state.share_registry)) {
                warn!("File index update failed during share event: {}", e);
            }

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

    match state.share_registry.remove_share(&requesting_user, &payload.file_path, &payload.user_to_remove) {
        Ok(_) => {
            // Re-index file to reflect updated permissions in Tantivy
            let path = Path::new(&payload.file_path);
            if let Err(e) = FileManager::process_and_index_file(path, &state.search_manager, Some(&state.share_registry)) {
                warn!("File index update failed during unshare event: {}", e);
            }

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
    let requesting_user = get_request_user(&headers, params.user.as_deref(), params.token.as_deref(), &state.account_manager)?;

    let owned_shares = state.share_registry.get_shares_by_owner(&requesting_user);
    let shared_with_me = state.share_registry.get_shares_for_user(&requesting_user);

    Ok(Json(ShareListResponse {
        owned_shares,
        shared_with_me,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

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
