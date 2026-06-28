/** Ollama binary assets (GitHub release). Pure, testable. */

// Pinned release version. Bump deliberately after reviewing the changelog.
export const OLLAMA_VERSION = 'v0.30.10';

// Pinned SHA256 for each asset (from the `digest` field of the GitHub release, immutable bytes).
// Verifying before extracting/executing protects against corruption and tampered origin (fail-closed).
export const OLLAMA_ASSET_SHA256: Record<string, string> = {
  'ollama-darwin.tgz': 'ad8a4d2918ed09480b8160419570602b4f49e48c9e3792efb601c0f54619e48e',
  'ollama-linux-amd64.tar.zst': '046d8f28e58d58477a49558d8d1bcb2e81ca8b287f93c44b12ff919c10d178dd',
  'ollama-linux-arm64.tar.zst': 'b626aef722ddb9d64dd20a76eeba9267abc5e9494faabb97839db85462b707d7',
  'ollama-windows-amd64.zip': '9606cee7501703a0969682667def313130f99ed73f44a88a7a8efe82d4b565f0',
  'ollama-windows-arm64.zip': 'fe9e06480417c4ca651d1b010a3fe6654f8740ad076632a46ef3d638773888d3',
};

export type ArchiveFormat = 'gz' | 'zst' | 'zip';

/** Asset name for the platform/arch (or null if unsupported). macOS is universal (single .tgz). */
export function ollamaAsset(platform: string, arch: string): string | null {
  if (platform === 'darwin') return 'ollama-darwin.tgz';
  if (platform === 'linux') return arch === 'arm64' ? 'ollama-linux-arm64.tar.zst' : 'ollama-linux-amd64.tar.zst';
  if (platform === 'win32') return arch === 'arm64' ? 'ollama-windows-arm64.zip' : 'ollama-windows-amd64.zip';
  return null;
}

/** Archive format of the asset, used to choose the extraction command. */
export function assetFormat(asset: string): ArchiveFormat {
  if (asset.endsWith('.tgz') || asset.endsWith('.tar.gz')) return 'gz';
  if (asset.endsWith('.tar.zst')) return 'zst';
  return 'zip';
}

/** Download URL of the asset in the pinned release. */
export function ollamaAssetUrl(asset: string): string {
  return `https://github.com/ollama/ollama/releases/download/${OLLAMA_VERSION}/${asset}`;
}

/** Ollama executable name for the given OS. */
export function ollamaBinName(platform: string): string {
  return platform === 'win32' ? 'ollama.exe' : 'ollama';
}
