mod board_storage;
mod photo_import;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            photo_import::import_images,
            board_storage::save_board,
            board_storage::load_board,
            board_storage::list_boards,
            board_storage::delete_board,
            board_storage::cleanup_orphan_assets,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flow");
}
