# MQTV Desktop

## Project layout

- `frontend/` is the React/TypeScript source root; `@/` resolves to it in TypeScript and Vite.
- `frontend/api/` only defines request endpoints, parameters, response types, and HTTP/Quark native request functions. Do not put persistence, cache management, response-to-view mapping, environment configuration, or platform utilities in this directory.
- `frontend/services/` combines API requests with domain parsing, cache storage, and business workflows. Views may call an API directly when no orchestration is needed; do not build HTTP endpoints/query strings or call `requestJson`/`invoke` in views.
- `frontend/config/services.ts` owns public environment configuration; `frontend/platform/desktop.ts` owns desktop detection, system/app metadata, concurrency queries, and external-link opening.
- `frontend/utils/url.ts` validates HTTP URLs and merges encoded query parameters; `utils/request.ts` owns unified JSON transport and normalized errors. Image requests live in `api/images.ts`. Keep timeout/status/size validation in native transport; do not automatically retry requests.
- Root `.env`/`.env.example` define public service origins; `.env.local` is ignored. `VITE_API_BASE_URL` is shared by Vite and native build configuration (`src-tauri/build.rs` and `src-tauri/src/config.rs`). Never put credentials in VITE variables. Use `MQTV_ENV_MODE` for a custom mode shared by frontend and Rust builds.
- `frontend/services/images.ts` owns IndexedDB image storage and cache-first loading.
- `frontend/domain/` owns parsers, search grouping/scoring, source policies, cache rules, and update validation. Tests are centralized under `frontend/tests/`, mirroring the relevant configuration, services, and domain directory structure.
- `frontend/router/` owns channel definitions, page/settings types, and in-memory navigation. Search state remains in the application view across navigation.
- `frontend/views/` groups discovery, search, player, settings, application composition, and shared components by feature.
- `frontend/assets/images/` contains local images imported through Vite.
- `frontend/styles/index.css` preserves CSS import order; `frontend/theme/` owns the MUI theme.
- `frontend/main.tsx` mounts the application; root `index.html` is the Vite HTML entry.
- `src-tauri/src/lib.rs` only assembles plugins, registers native commands, and starts Tauri; `main.rs` remains the desktop entry.
- `src-tauri/src/commands/` owns generic native capabilities: app/system metadata and build number in `app.rs`, JSON transport in `http.rs`, and image downloading/validation in `images.rs`.
- Root `Cargo.toml` owns the Cargo workspace, release profile and shared `Cargo.lock`. `crates/netdisk/` is a Tauri-independent library for provider protocols, QR sessions, share files/episodes, transfer/playback and the media proxy. It receives credentials through `CredentialStore`; it must not depend on Tauri, keyring, tvadmin or application environment configuration.
- `src-tauri/src/features/quark/` owns application credential storage, tvadmin authorization, WoGG source search and Tauri command adapters. Keep the existing command contracts and keyring identity; use the netdisk package shared authorization lock across authorization, login and playback.
- Native application test sources are centralized under `src-tauri/src/tests/` (`config.rs`, `quark/`); independent netdisk tests live under `crates/netdisk/src/tests/`. Keep `#[cfg(test)]` + `#[path]` child-module references in implementation modules to preserve private access without widening visibility. Quark account/network smoke tests and real QR login remain opt-in and ignored by default.
- The sibling `maolike-desktop` is an architectural reference, not part of this checkout.

## Compatibility

- Preserve localStorage keys, IndexedDB database/store names, authorization storage, application identifier, and native command contracts when reorganizing code.
- Discovery lists compare successful fetch age against one hour at application startup. Reuse within the same run; explicit retry handles failures. Resource subscription caching has its own seven-day policy.
- Images persist as ArrayBuffer bytes in IndexedDB for WebKit restart compatibility. The image cache is bounded to 128 MiB, with 120 recently used images in memory.
- Keep existing navigation, search ordering, source integration restrictions, and playback behavior unless a task explicitly changes them.

## Commands

- Desktop development: `pnpm dev` (or `npm run tauri dev`). Web frontend only: `pnpm dev:web`.
- Frontend validation: `npm run build` and `npx vitest run`.
- Native compile check: `cargo check --manifest-path src-tauri/Cargo.toml`.
- Native unit tests for all packages: `cargo test --workspace --lib`. Standalone netdisk validation: `cargo test -p mqtv-netdisk`.
- Real network/account smoke tests are opt-in; follow `docs/development.md` instructions and distinguish them from mocks, browser checks, and compilation.
- Packaging/signing requirements are documented in `docs/development.md`. Directory organization alone does not authorize replacing an installed application or publishing a release.

## Function documentation

- Add Chinese JSDoc to each named production JavaScript/TypeScript function, including exported requests, internal helpers, components, hooks, named event handlers, and cache methods.
- Explain the function's purpose and observable behavior. Document non-obvious parameters, return values, errors, side effects, cache policy, and authorization constraints where relevant; avoid repeating TypeScript types or adding filler comments to anonymous JSX/array/test callbacks.
- Keep documentation beside implementation and update it when behavior changes. Keep all tests under `frontend/tests/` or `src-tauri/src/tests/`.
