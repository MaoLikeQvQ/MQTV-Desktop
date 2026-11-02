//! UC 应用授权与命令适配；协议由独立 netdisk 包提供，凭证与夸克隔离。
pub(crate) mod authorization;
mod client;
pub(crate) mod credentials;
pub(crate) mod files;
pub(crate) mod login;
pub(crate) mod playback;
pub(crate) mod search;
