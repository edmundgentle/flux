use crate::cv::CvPipeline;
use crate::search::{SearchDocument, SearchManager};
use crate::sharing::ShareRegistry;
use notify::{EventKind, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{error, info, warn};

pub struct FileManager;

impl FileManager {
    /// Saves bytes into a target path and indexes it immediately with user metadata
    pub fn save_and_index_file(
        data: &[u8],
        target_path: &Path,
        search_manager: &SearchManager,
        sharing_registry: Option<&ShareRegistry>,
    ) -> Result<(), String> {
        // Ensure parent directory exists
        if let Some(parent) = target_path.parent() {
            if !parent.exists() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent directories: {}", e))?;
            }
        }

        // Write file
        fs::write(target_path, data)
            .map_err(|e| format!("Failed to write file to disk: {}", e))?;

        info!("Saved file to {:?}", target_path);

        // Process and Index
        Self::process_and_index_file(target_path, search_manager, sharing_registry)?;

        Ok(())
    }

    /// Deletes a file from disk and search index
    pub fn delete_file(
        target_path: &Path,
        search_manager: &SearchManager,
    ) -> Result<(), String> {
        let path_str = target_path.to_string_lossy().to_string();
        
        // Remove from index first
        search_manager.delete_document(&path_str)?;

        // Remove from disk
        if target_path.exists() {
            fs::remove_file(target_path)
                .map_err(|e| format!("Failed to delete file from disk: {}", e))?;
            info!("Deleted file from disk {:?}", target_path);
        }

        Ok(())
    }

    /// Inspects the file type and indexes metadata, contents, or runs visual model analyses
    pub fn process_and_index_file(
        file_path: &Path,
        search_manager: &SearchManager,
        sharing_registry: Option<&ShareRegistry>,
    ) -> Result<(), String> {
        let path_str = file_path.to_string_lossy().to_string();
        let file_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        let mut content = String::new();
        let mut tags = Vec::new();
        let mut faces = Vec::new();
        let mut latitude = None;
        let mut longitude = None;
        let mut date_created = 0;

        // Obtain default system file modification time
        if let Ok(metadata) = fs::metadata(file_path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    date_created = duration.as_secs() as i64;
                }
            }
        }

        match ext.as_str() {
            // Image extensions
            "jpg" | "jpeg" | "png" | "webp" | "tiff" | "bmp" => {
                match CvPipeline::analyze_image(file_path) {
                    Ok(res) => {
                        tags = res.tags;
                        faces = res.faces;
                        if let Some(lat) = res.latitude {
                            latitude = Some(lat);
                        }
                        if let Some(lon) = res.longitude {
                            longitude = Some(lon);
                        }
                        if let Some(dt) = res.date_created {
                            date_created = dt;
                        }
                        tags.push("image".to_string());
                    }
                    Err(e) => {
                        warn!("Image CV pipeline failed for {:?}: {}", file_path, e);
                        tags.push("image".to_string());
                        tags.push("uncategorized".to_string());
                    }
                }
            }
            // Document extensions
            "txt" | "md" | "json" | "csv" | "log" | "yaml" | "yml" | "xml" => {
                if let Ok(text) = fs::read_to_string(file_path) {
                    content = if text.len() > 100_000 {
                        text[..100_000].to_string()
                    } else {
                        text
                    };
                }
                tags.push("document".to_string());
                tags.push(ext.clone());
            }
            // Catch-all
            _ => {
                tags.push("file".to_string());
                if !ext.is_empty() {
                    tags.push(ext.clone());
                }
            }
        }

        // Determine owner and allowed readers
        let owner = Self::extract_owner_from_path(file_path);
        let mut allowed_users = vec![owner.clone()];
        
        if let Some(registry) = sharing_registry {
            let shared = registry.get_allowed_users(&path_str);
            for user in shared {
                if !allowed_users.contains(&user) {
                    allowed_users.push(user);
                }
            }
        }

        let doc = SearchDocument {
            path: path_str,
            file_name,
            content,
            tags,
            faces,
            latitude,
            longitude,
            date_created,
            owner,
            allowed_users,
        };

        info!("Indexed data for {:?}: {:#?}", file_path, doc);

        search_manager.index_document(doc)?;
        Ok(())
    }

    /// Recursively scans and indexes files inside a directory
    pub fn scan_directory_recursive(
        dir_path: &Path,
        search_manager: &SearchManager,
        sharing_registry: Option<&ShareRegistry>,
    ) {
        info!("Scanning directory recursively: {:?}", dir_path);
        let walker = walkdir::WalkDir::new(dir_path).into_iter();
        for entry in walker.filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let path = entry.path();
                info!("Discovered file in scan: {:?}", path);
                if let Err(e) = Self::process_and_index_file(path, search_manager, sharing_registry) {
                    error!("Failed to index file {:?}: {}", path, e);
                }
            }
        }
    }

    /// Launches a background file watcher utilizing the notify crate
    pub fn start_file_watcher(
        scan_dirs: Vec<String>,
        search_manager: SearchManager,
        sharing_registry: Option<ShareRegistry>,
    ) -> Result<notify::RecommendedWatcher, String> {
        let (tx, rx) = std::sync::mpsc::channel();

        let mut watcher = notify::recommended_watcher(tx)
            .map_err(|e| format!("Failed to create watcher: {}", e))?;

        for dir in &scan_dirs {
            let path = Path::new(dir);
            if path.exists() && path.is_dir() {
                if let Err(e) = watcher.watch(path, RecursiveMode::Recursive) {
                    error!("Watcher failed to watch {:?}: {}", path, e);
                } else {
                    info!("File watcher actively monitoring {:?}", path);
                }
            } else {
                warn!("Scan directory {:?} does not exist, watcher skipped it.", dir);
            }
        }

        // Spawn processor thread for monitoring events
        std::thread::spawn(move || {
            let mut pending_files = HashSet::new();
            let mut pending_removals = HashSet::new();

            for res in rx {
                match res {
                    Ok(event) => match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Any => {
                            for path in event.paths {
                                if path.is_file() {
                                    pending_files.insert(path);
                                } else if !path.exists() {
                                    pending_removals.insert(path);
                                }
                            }
                        }
                        EventKind::Remove(_) => {
                            for path in event.paths {
                                pending_removals.insert(path);
                            }
                        }
                        _ => {}
                    },
                    Err(e) => {
                        error!("File watcher channel error: {:?}", e);
                    }
                }

                if !pending_files.is_empty() || !pending_removals.is_empty() {
                    let files_to_process: Vec<PathBuf> = pending_files.drain().collect();
                    let removals_to_process: Vec<PathBuf> = pending_removals.drain().collect();
                    let sm = search_manager.clone();
                    let reg = sharing_registry.clone();

                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(250));

                        for path in files_to_process {
                            if path.is_file() {
                                info!("File watcher detected modification on {:?}", path);
                                if let Err(e) = Self::process_and_index_file(&path, &sm, reg.as_ref()) {
                                    error!("Failed to index watched file {:?}: {}", path, e);
                                }
                            }
                        }

                        for path in removals_to_process {
                            let path_str = path.to_string_lossy().to_string();
                            if path.exists() {
                                continue;
                            }
                            info!("File watcher detected removal on {:?}", path_str);
                            if let Err(e) = sm.delete_document(&path_str) {
                                error!("Failed to delete index for watched file {:?}: {}", path_str, e);
                            }
                        }
                    });
                }
            }
        });

        Ok(watcher)
    }

    /// Extracts owner from file path based on "users" folder layout
    fn extract_owner_from_path(path: &Path) -> String {
        let components: Vec<_> = path.components().collect();
        for i in 0..components.len() {
            if components[i].as_os_str() == "users" && i + 1 < components.len() {
                return components[i + 1].as_os_str().to_string_lossy().to_string();
            }
        }

        for category in ["Photos", "Documents", "Files", "Notes", "Contacts"] {
            for i in 1..components.len() {
                if components[i].as_os_str() == category && i > 0 {
                    return components[i - 1].as_os_str().to_string_lossy().to_string();
                }
            }
        }

        let ignored = [
            "",
            ".",
            "..",
            "config",
            "data",
            "media",
            "mnt",
            "share",
            "srv",
            "tmp",
            "var",
            "Users",
            "users",
            "home",
            "opt",
            "search_vision",
        ];

        for component in components.iter().skip(1) {
            let component_str = component.as_os_str().to_string_lossy().to_string();
            if ignored.contains(&component_str.as_str()) {
                continue;
            }
            return component_str;
        }

        "admin".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_owner_from_user_workspace_path() {
        let path = Path::new("/data/alice/Photos/photo.jpg");
        assert_eq!(FileManager::extract_owner_from_path(path), "alice");
    }

    #[test]
    fn extracts_owner_from_default_home_assistant_workspace_path() {
        let path = Path::new("/config/search_vision/alice/Photos/photo.jpg");
        assert_eq!(FileManager::extract_owner_from_path(path), "alice");
    }

    #[test]
    fn extracts_owner_from_notes_and_contacts_workspace_paths() {
        let note_path = Path::new("/config/search_vision/alice/Notes/note_123.md");
        assert_eq!(FileManager::extract_owner_from_path(note_path), "alice");

        let contact_path = Path::new("/config/search_vision/bob/Contacts/contact_456.json");
        assert_eq!(FileManager::extract_owner_from_path(contact_path), "bob");
    }
}
