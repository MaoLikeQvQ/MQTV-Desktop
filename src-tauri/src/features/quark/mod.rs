//! Quark authorization, source discovery, file browsing, and playback.
pub(crate) mod authorization;
mod client;
pub(crate) mod credentials;
pub(crate) mod files;
pub(crate) mod login;
pub(crate) mod playback;
pub(crate) mod search;

#[cfg(test)]
#[path = "../../tests/quark/smoke.rs"]
mod tests;
