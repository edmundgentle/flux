use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::process::Command;
use tracing::{error, info};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MountInfo {
    pub device: String,
    pub mount_point: String,
    pub fs_type: String,
    pub options: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StorageInfo {
    pub path: String,
    pub exists: bool,
    pub is_dir: bool,
    pub disk_space: Option<DiskSpace>,
}

pub struct StorageManager;

impl StorageManager {
    /// Lists all current mounts by reading /proc/mounts
    pub fn list_mounts() -> Result<Vec<MountInfo>, String> {
        let path = Path::new("/proc/mounts");
        if !path.exists() {
            return Err("System mounts file /proc/mounts not found. Not running on Linux?".to_string());
        }

        let content = fs::read_to_string(path)
            .map_err(|e| format!("Failed to read /proc/mounts: {}", e))?;

        let mut mounts = Vec::new();
        for line in content.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 4 {
                mounts.push(MountInfo {
                    device: parts[0].to_string(),
                    mount_point: parts[1].to_string(),
                    fs_type: parts[2].to_string(),
                    options: parts[3].to_string(),
                });
            }
        }
        Ok(mounts)
    }

    /// Scans a directory and returns basic info about sub-directories/drives
    pub fn scan_directory(dir_path: &str) -> Result<Vec<StorageInfo>, String> {
        let path = Path::new(dir_path);
        if !path.exists() {
            return Err(format!("Directory path does not exist: {}", dir_path));
        }

        if !path.is_dir() {
            return Err(format!("Path is not a directory: {}", dir_path));
        }

        let mut results = Vec::new();
        let entries = fs::read_dir(path)
            .map_err(|e| format!("Failed to read directory entries: {}", e))?;

        for entry in entries.flatten() {
            let entry_path = entry.path();
            let path_str = entry_path.to_string_lossy().to_string();
            let is_dir = entry_path.is_dir();

            let disk_space = if is_dir {
                Self::get_disk_space(&path_str).ok()
            } else {
                None
            };

            results.push(StorageInfo {
                path: path_str,
                exists: true,
                is_dir,
                disk_space,
            });
        }

        Ok(results)
    }

    /// Mounts an external drive or network share
    pub fn mount_device(source: &str, target: &str, fs_type: Option<&str>, options: Option<&str>) -> Result<(), String> {
        let target_path = Path::new(target);
        if !target_path.exists() {
            fs::create_dir_all(target_path)
                .map_err(|e| format!("Failed to create mount target directory: {}", e))?;
        }

        let mut args = Vec::new();
        if let Some(t) = fs_type {
            args.push("-t");
            args.push(t);
        }
        if let Some(o) = options {
            args.push("-o");
            args.push(o);
        }
        args.push(source);
        args.push(target);

        info!("Executing mount command: mount {:?}", args);

        let output = Command::new("mount")
            .args(&args)
            .output()
            .map_err(|e| format!("Failed to execute mount command: {}", e))?;

        if !output.status.success() {
            let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
            error!("Mount command failed: {}", err_msg);
            return Err(format!("Mount command failed: {}", err_msg));
        }

        info!("Successfully mounted {} to {}", source, target);
        Ok(())
    }

    /// Unmounts a mounted target path
    pub fn umount(target: &str) -> Result<(), String> {
        info!("Executing umount: {}", target);
        let output = Command::new("umount")
            .arg(target)
            .output()
            .map_err(|e| format!("Failed to execute umount command: {}", e))?;

        if !output.status.success() {
            let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
            error!("Umount failed: {}", err_msg);
            return Err(format!("Umount failed: {}", err_msg));
        }

        info!("Successfully unmounted {}", target);
        Ok(())
    }

    /// Helper to get disk space using sysfs or falling back to shell `df`
    pub fn get_disk_space(path: &str) -> Result<DiskSpace, String> {
        // Run df -B1 <path> and parse output
        let output = Command::new("df")
            .args(["-B1", path])
            .output()
            .map_err(|e| format!("Failed to run df command: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let lines: Vec<&str> = stdout.lines().collect();
        if lines.len() < 2 {
            return Err("Invalid df output".to_string());
        }

        // Output format:
        // Filesystem      1B-blocks      Used Available Use% Mounted on
        // /dev/sda1      1000000000 500000000 500000000  50% /mount
        let parts: Vec<&str> = lines[1].split_whitespace().collect();
        if parts.len() >= 4 {
            let total: u64 = parts[1].parse().unwrap_or(0);
            let used: u64 = parts[2].parse().unwrap_or(0);
            let avail: u64 = parts[3].parse().unwrap_or(0);
            return Ok(DiskSpace {
                total_bytes: total,
                available_bytes: avail,
                used_bytes: used,
            });
        }

        Err("Failed to parse df output columns".to_string())
    }
}
