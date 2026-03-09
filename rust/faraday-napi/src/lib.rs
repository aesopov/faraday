#![deny(clippy::all)]

use faraday_core::error::FsError;
use faraday_core::ops::{self, FdTable};
use faraday_core::watch::{EventCallback, FsWatcher};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadSafeCallContext, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::JsUnknown;
use napi_derive::napi;
use std::sync::{Arc, Mutex, OnceLock};

// ── Global state ────────────────────────────────────────────────────

static FD_TABLE: OnceLock<FdTable> = OnceLock::new();
static WATCHER: OnceLock<Mutex<Option<FsWatcher>>> = OnceLock::new();

fn fdt() -> &'static FdTable {
    FD_TABLE.get_or_init(FdTable::new)
}

fn watcher_lock() -> &'static Mutex<Option<FsWatcher>> {
    WATCHER.get_or_init(|| Mutex::new(None))
}

// ── Error conversion ────────────────────────────────────────────────

fn to_napi_error(e: FsError) -> Error {
    Error::new(Status::GenericFailure, format!("{} ({})", e, e.errno_str()))
}

// ── Exported functions ──────────────────────────────────────────────

#[napi(object)]
pub struct EntryInfo {
    pub name: String,
    pub kind: String,
    pub size: f64,
    pub mtime_ms: f64,
    pub mode: u32,
    pub nlink: u32,
    pub hidden: bool,
    pub link_target: Option<String>,
}

#[napi(object)]
pub struct StatResult {
    pub size: f64,
    pub mtime_ms: f64,
}

#[napi]
pub fn entries(dir_path: String) -> Result<Vec<EntryInfo>> {
    let list = ops::entries(&dir_path).map_err(to_napi_error)?;
    Ok(list
        .into_iter()
        .map(|e| EntryInfo {
            name: e.name,
            kind: e.kind.as_str().to_string(),
            size: e.size,
            mtime_ms: e.mtime_ms,
            mode: e.mode,
            nlink: e.nlink,
            hidden: e.hidden,
            link_target: e.link_target,
        })
        .collect())
}

#[napi]
pub fn stat(file_path: String) -> Result<StatResult> {
    let s = ops::stat(&file_path).map_err(to_napi_error)?;
    Ok(StatResult {
        size: s.size,
        mtime_ms: s.mtime_ms,
    })
}

#[napi]
pub fn exists(file_path: String) -> bool {
    ops::exists(&file_path)
}

#[napi]
pub fn open(file_path: String) -> Result<f64> {
    let fd = ops::open(&file_path, fdt()).map_err(to_napi_error)?;
    Ok(fd as f64)
}

#[napi]
pub fn read(fd: f64, offset: f64, length: f64) -> Result<Buffer> {
    let data = ops::pread(fd as i32, offset as u64, length as usize, fdt()).map_err(to_napi_error)?;
    Ok(data.into())
}

#[napi]
pub fn close(fd: f64) {
    ops::close(fd as i32, fdt());
}

// ── Watch ───────────────────────────────────────────────────────────

/// ThreadsafeFunction that receives (watch_id, kind, name?)
type WatchTsfn = ThreadsafeFunction<(String, String, Option<String>), ErrorStrategy::Fatal>;

static WATCH_TSFN: OnceLock<Mutex<Option<WatchTsfn>>> = OnceLock::new();

fn tsfn_lock() -> &'static Mutex<Option<WatchTsfn>> {
    WATCH_TSFN.get_or_init(|| Mutex::new(None))
}

#[napi(ts_args_type = "cb: (watchId: string, kind: string, name: string | null) => void")]
pub fn set_watch_callback(cb: JsFunction) -> Result<()> {
    let tsfn: WatchTsfn = cb.create_threadsafe_function(0, |ctx: ThreadSafeCallContext<(String, String, Option<String>)>| {
        let (watch_id, kind, name) = ctx.value;
        let js_watch_id = ctx.env.create_string(&watch_id)?;
        let js_kind = ctx.env.create_string(&kind)?;
        let js_name: JsUnknown = match name {
            Some(n) => ctx.env.create_string(&n)?.into_unknown(),
            None => ctx.env.get_null()?.into_unknown(),
        };
        Ok(vec![js_watch_id.into_unknown(), js_kind.into_unknown(), js_name])
    })?;

    // Store the tsfn
    *tsfn_lock().lock().unwrap() = Some(tsfn.clone());

    // Build the event callback for the watcher
    let event_cb: EventCallback = Arc::new(move |watch_id, kind, name| {
        let kind_str = kind.as_str().to_string();
        let watch_id = watch_id.to_string();
        let name = name.map(|n| n.to_string());
        tsfn.call((watch_id, kind_str, name), ThreadsafeFunctionCallMode::NonBlocking);
    });

    // Create or replace the watcher
    let new_watcher = FsWatcher::new(event_cb).map_err(|e| {
        Error::new(Status::GenericFailure, format!("failed to create watcher: {e}"))
    })?;
    *watcher_lock().lock().unwrap() = Some(new_watcher);

    Ok(())
}

#[napi]
pub fn clear_watch_callback() {
    // Drop the watcher first (stops all watches)
    *watcher_lock().lock().unwrap() = None;
    // Then drop the tsfn
    *tsfn_lock().lock().unwrap() = None;
}

#[napi]
pub fn watch(watch_id: String, dir_path: String) -> Result<bool> {
    let guard = watcher_lock().lock().unwrap();
    match guard.as_ref() {
        Some(w) => Ok(w.add(&watch_id, &dir_path)),
        None => Err(Error::new(
            Status::GenericFailure,
            "no watch callback set",
        )),
    }
}

#[napi]
pub fn unwatch(watch_id: String) {
    let guard = watcher_lock().lock().unwrap();
    if let Some(w) = guard.as_ref() {
        w.remove(&watch_id);
    }
}
