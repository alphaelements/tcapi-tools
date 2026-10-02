mod commands;
mod events;
mod state;

use std::sync::{Arc, Mutex};

use state::{AppInner, SharedState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let shared: SharedState = Arc::new(Mutex::new(AppInner::default()));
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(shared)
        .invoke_handler(tauri::generate_handler![
            commands::discover,
            commands::connect,
            commands::disconnect,
            commands::get_version,
            commands::get_caps,
            commands::get_info,
            commands::set_device_number,
            commands::read_inputs,
            commands::write_outputs,
            commands::read_state,
            commands::subscribe,
            commands::map_get,
            commands::map_set,
            commands::map_save,
            commands::map_default,
            commands::map_load_toml,
            commands::pattern_load,
            commands::pattern_load_toml,
            commands::pattern_run,
            commands::pattern_stop,
            commands::pattern_status,
            commands::pattern_reset,
            commands::system_reset,
            commands::bootsel_reset,
            commands::ts_arm,
            commands::ts_get,
            commands::ts_get_reconciled,
            commands::ts_disarm,
            commands::sync_arm,
            commands::sync_master,
            commands::sync_start,
            commands::sync_stop,
            commands::sync_count,
            commands::sync_disarm,
            commands::raw_command,
            commands::write_text_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
