/**
 * What: Ambient TS types for Vite — /// <reference types="vite/client" />. Enables import.meta.env, ?url asset
 * imports, and default CSS module shapes without per-file imports. No runtime exports. To type custom env vars
 * (e.g. VITE_*): extend ImportMetaEnv interface in this file per Vite docs. Application domain types belong in
 * src/types or feature modules — not vite-env.d.ts. Build/plugins: vite.config.ts — not here.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
 */
/// <reference types="vite/client" />
