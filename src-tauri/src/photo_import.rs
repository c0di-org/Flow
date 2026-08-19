use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader};
use serde::Serialize;
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
};
use tauri::{ipc::Channel, AppHandle, Manager};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};
use uuid::Uuid;

const MAX_PIXELS: u64 = 55_000_000;
const MAX_SOURCE_BYTES: u64 = 750 * 1024 * 1024;
const PREVIEW_EDGE: u32 = 1600;
const THUMB_EDGE: u32 = 420;
const MICRO_EDGE: u32 = 160;

#[derive(Clone, Serialize)]
pub struct ImportedAsset {
    id: String,
    name: String,
    original_path: String,
    preview_path: String,
    thumbnail_path: String,
    micro_path: String,
    pixel_width: u32,
    pixel_height: u32,
    bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImportEvent {
    Started { total: usize },
    Imported { asset: ImportedAsset },
    Failed { path: String, message: String },
    Finished { imported: usize, failed: usize },
}

#[tauri::command]
pub async fn import_images(
    app: AppHandle,
    board_id: String,
    paths: Vec<String>,
    on_event: Channel<ImportEvent>,
) -> Result<(), String> {
    validate_board_id(&board_id)?;
    let data_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let total = paths.len();
    let _ = on_event.send(ImportEvent::Started { total });

    tauri::async_runtime::spawn_blocking(move || {
        let mut imported = 0usize;
        let mut failed = 0usize;
        // Deliberately sequential: decoding giant photos concurrently creates large,
        // short-lived RAM spikes on tablets and lower-memory laptops.
        for raw_path in paths {
            match import_one(&app, &data_root, &board_id, &raw_path) {
                Ok(asset) => {
                    imported += 1;
                    let _ = on_event.send(ImportEvent::Imported { asset });
                }
                Err(message) => {
                    failed += 1;
                    let _ = on_event.send(ImportEvent::Failed { path: raw_path, message });
                }
            }
        }
        let _ = on_event.send(ImportEvent::Finished { imported, failed });
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn validate_board_id(id: &str) -> Result<(), String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(())
    } else {
        Err("Invalid board id".into())
    }
}

fn display_name(raw: &str) -> String {
    raw.rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("Photo")
        .split('?')
        .next()
        .unwrap_or("Photo")
        .to_string()
}

fn import_one(app: &AppHandle, data_root: &Path, board_id: &str, raw_source: &str) -> Result<ImportedAsset, String> {
    let id = Uuid::new_v4().to_string();
    let root = data_root.join("boards").join(board_id).join("assets");
    let originals = root.join("originals");
    let previews = root.join("previews");
    let thumbs = root.join("thumbnails");
    let micros = root.join("micro");
    fs::create_dir_all(&originals).map_err(|e| e.to_string())?;
    fs::create_dir_all(&previews).map_err(|e| e.to_string())?;
    fs::create_dir_all(&thumbs).map_err(|e| e.to_string())?;
    fs::create_dir_all(&micros).map_err(|e| e.to_string())?;

    let source_path: FilePath = raw_source.parse().expect("FilePath parsing is infallible");
    let mut options = OpenOptions::new();
    options.read(true);
    let source = app.fs().open(source_path.clone(), options).map_err(|e| format!("Could not open photo: {e}"))?;

    let original_path = originals.join(format!("{id}.source"));
    let temp_path = originals.join(format!("{id}.part"));
    let copy_result = copy_bounded(source, &temp_path);
    #[cfg(target_os = "ios")]
    let _ = app.fs().stop_accessing_security_scoped_resource(source_path);
    let bytes = match copy_result {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&temp_path, &original_path) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("Could not finalize photo: {error}"));
    }

    let preview_target = previews.join(format!("{id}.webp"));
    let thumb_target = thumbs.join(format!("{id}.webp"));
    let micro_target = micros.join(format!("{id}.webp"));
    let result = decode_derivatives(&original_path, &preview_target, &thumb_target, &micro_target);
    let (width, height, preview_path, thumbnail_path, micro_path) = match result {
        Ok(value) => value,
        Err(error) => {
            for path in [&original_path, &preview_target, &thumb_target, &micro_target] {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
    };

    Ok(ImportedAsset {
        id,
        name: display_name(raw_source),
        original_path: path_string(original_path),
        preview_path: path_string(preview_path),
        thumbnail_path: path_string(thumbnail_path),
        micro_path: path_string(micro_path),
        pixel_width: width,
        pixel_height: height,
        bytes,
    })
}

fn copy_bounded<R: Read>(source: R, destination: &Path) -> Result<u64, String> {
    let mut limited = source.take(MAX_SOURCE_BYTES + 1);
    let mut out = fs::File::create(destination).map_err(|e| format!("Could not create local photo copy: {e}"))?;
    let copied = io::copy(&mut limited, &mut out).map_err(|e| format!("Could not copy photo: {e}"))?;
    if copied > MAX_SOURCE_BYTES {
        let _ = fs::remove_file(destination);
        return Err("Photo is larger than the 750 MB import safety limit".into());
    }
    Ok(copied)
}

fn decode_derivatives(
    source: &Path,
    preview_path: &Path,
    thumb_path: &Path,
    micro_path: &Path,
) -> Result<(u32, u32, PathBuf, PathBuf, PathBuf), String> {
    let reader = ImageReader::open(source)
        .map_err(|e| format!("Could not open copied image: {e}"))?
        .with_guessed_format()
        .map_err(|e| format!("Could not detect image format: {e}"))?;
    let mut decoder = reader.into_decoder().map_err(|e| format!("Unsupported or damaged image: {e}"))?;
    let (raw_width, raw_height) = decoder.dimensions();
    if u64::from(raw_width) * u64::from(raw_height) > MAX_PIXELS {
        return Err(format!("Image exceeds Flow's 55 MP tablet-safe decode limit: {raw_width}×{raw_height}"));
    }

    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| format!("Could not decode pixels: {e}"))?;
    image.apply_orientation(orientation);
    let width = image.width();
    let height = image.height();

    let preview = image.thumbnail(PREVIEW_EDGE, PREVIEW_EDGE);
    drop(image);
    let thumb = preview.thumbnail(THUMB_EDGE, THUMB_EDGE);
    let micro = thumb.thumbnail(MICRO_EDGE, MICRO_EDGE);
    save_webp(&preview, preview_path)?;
    save_webp(&thumb, thumb_path)?;
    save_webp(&micro, micro_path)?;
    Ok((width, height, preview_path.to_path_buf(), thumb_path.to_path_buf(), micro_path.to_path_buf()))
}

fn save_webp(image: &DynamicImage, path: &Path) -> Result<(), String> {
    image.save_with_format(path, ImageFormat::WebP).map_err(|e| format!("Could not write preview: {e}"))
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
