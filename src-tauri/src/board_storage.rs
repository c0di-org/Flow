use serde::Serialize;
use serde_json::Value;
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardSummary {
    id: String,
    title: String,
    updated_at: u64,
}

fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err("Invalid board id".into())
    }
}

fn boards_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("boards"))
}

fn backup_path(path: &Path) -> std::path::PathBuf {
    path.with_extension("json.bak")
}

fn read_recoverable(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path)
        .or_else(|_| fs::read(backup_path(path)))
        .map_err(|e| e.to_string())
}

fn recoverable_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let temp = path.with_extension("json.part");
    let backup = backup_path(path);
    let _ = fs::remove_file(&temp);

    {
        let mut file = fs::File::create(&temp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }

    match fs::rename(&temp, path) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(error) => {
            if backup.exists() && !path.exists() {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(&temp);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub fn save_board(app: AppHandle, board: Value) -> Result<(), String> {
    let id = board.get("id").and_then(Value::as_str).ok_or("Board is missing an id")?;
    let id = safe_id(id)?;
    let root = boards_root(&app)?.join(id);
    let json = serde_json::to_vec_pretty(&board).map_err(|e| e.to_string())?;
    recoverable_write(&root.join("board.json"), &json)
}

#[tauri::command]
pub fn load_board(app: AppHandle, board_id: String) -> Result<Value, String> {
    let id = safe_id(&board_id)?;
    let path = boards_root(&app)?.join(id).join("board.json");
    let bytes = read_recoverable(&path)?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_boards(app: AppHandle) -> Result<Vec<BoardSummary>, String> {
    let root = boards_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut boards = Vec::new();
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let board_path = entry.path().join("board.json");
        let Ok(bytes) = read_recoverable(&board_path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
        let Some(id) = value.get("id").and_then(Value::as_str) else { continue };
        if safe_id(id).is_err() { continue; }
        let title = value.get("title").and_then(Value::as_str).unwrap_or("Untitled Board").to_string();
        let updated_at = value.get("updatedAt").and_then(Value::as_u64).unwrap_or_default();
        boards.push(BoardSummary { id: id.to_string(), title, updated_at });
    }
    boards.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(boards)
}

#[tauri::command]
pub fn delete_board(app: AppHandle, board_id: String) -> Result<(), String> {
    let id = safe_id(&board_id)?;
    let root = boards_root(&app)?.join(id);
    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn cleanup_orphan_assets(app: AppHandle) -> Result<usize, String> {
    let root = boards_root(&app)?;
    if !root.exists() {
        return Ok(0);
    }

    let mut removed = 0usize;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        let board_dir = entry.path();
        let board_path = board_dir.join("board.json");
        let Ok(bytes) = read_recoverable(&board_path) else { continue };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };

        let mut live = std::collections::HashSet::new();
        if let Some(elements) = value.get("elements").and_then(Value::as_array) {
            for element in elements {
                if element.get("kind").and_then(Value::as_str) != Some("photo") {
                    continue;
                }
                if let Some(id) = element
                    .get("asset")
                    .and_then(|asset| asset.get("id"))
                    .and_then(Value::as_str)
                {
                    live.insert(id.to_string());
                }
            }
        }

        let asset_root = board_dir.join("assets");
        for folder in ["originals", "previews", "thumbnails", "micro"] {
            let dir = asset_root.join(folder);
            let Ok(files) = fs::read_dir(&dir) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if !path.is_file() {
                    continue;
                }
                let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or_default();
                let is_partial = path.extension().and_then(|value| value.to_str()) == Some("part");
                if is_partial || (!stem.is_empty() && !live.contains(stem)) {
                    if fs::remove_file(path).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
    }
    Ok(removed)
}
