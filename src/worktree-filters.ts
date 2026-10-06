/** Synced metadata inside a worktree. Every file in it has exactly one writer, so
    Syncthing never has to resolve a conflict between nodes. */
export const WORKTREE_META_DIR = ".joint-bob-worktree";
export const WORKTREE_FOLDER_PREFIX = "joint-bob-worktrees-";

/** Dependency, build and cache trees that never belong in a lightweight worktree. */
export const worktreeHeavyDirectories = [
  "target", ".next", ".nuxt", ".svelte-kit", ".angular", ".turbo", ".cache", ".parcel-cache", ".vite", ".gradle", ".m2",
  "Pods", "DerivedData", ".tox", ".nox", ".eggs", "site-packages", "vendor", "bower_components", "jspm_packages",
  ".yarn", ".pnpm-store", ".npm", ".terraform", ".serverless", ".vercel", ".netlify", ".expo", ".dart_tool",
  "out", "tmp", ".tmp", ".idea", ".stversions", ".stfolder",
] as const;
export const worktreeHeavyFiles = [".stignore"] as const;

export const worktreeBinaryExtensions = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "heic", "psd", "ai", "sketch", "fig",
  "mp4", "mov", "avi", "mkv", "webm", "mp3", "wav", "flac", "ogg", "m4a", "aac",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "jar", "war", "class", "dex", "apk", "ipa", "aab",
  "so", "dylib", "dll", "exe", "bin", "o", "a", "lib", "obj", "pdb", "pyc", "pyo", "whl", "egg", "wasm", "node",
  "sqlite", "sqlite3", "db", "pdf", "woff", "woff2", "ttf", "otf", "eot", "dmg", "iso", "pkg", "deb", "rpm", "msi",
] as const;
