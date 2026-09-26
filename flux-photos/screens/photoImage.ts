import * as FileSystem from 'expo-file-system/legacy';
import { FluxClient } from '@flux-sdk/core';

// In-flight/loaded URI per path, so concurrent grid+viewer requests share one download.
const memoryCache = new Map<string, Promise<string>>();
const CACHE_DIR = `${FileSystem.cacheDirectory}flux-photos/`;

// Stable filename per photo path so repeat launches can reuse the on-disk copy.
function cacheFileName(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) | 0;
  }
  const extension = path.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return `${Math.abs(hash)}.${extension}`;
}

async function ensureCacheDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CACHE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
  }
}

async function loadPhotoUri(client: FluxClient, path: string): Promise<string> {
  await ensureCacheDir();
  const fileUri = `${CACHE_DIR}${cacheFileName(path)}`;

  const existing = await FileSystem.getInfoAsync(fileUri);
  if (existing.exists) return fileUri;

  // Uses the data-URI download (not downloadFile/Blob): React Native's Blob can't be
  // constructed from raw bytes, so a data URI is the only form we can get bytes from here.
  const dataUri = await client.downloadFileAsDataUri(path);
  const base64 = dataUri.slice(dataUri.indexOf(',') + 1);
  await FileSystem.writeAsStringAsync(fileUri, base64, { encoding: FileSystem.EncodingType.Base64 });
  return fileUri;
}

export function getPhotoUri(client: FluxClient, path: string): Promise<string> {
  const cached = memoryCache.get(path);
  if (cached) return cached;

  const promise = loadPhotoUri(client, path).catch((error) => {
    memoryCache.delete(path);
    throw error;
  });
  memoryCache.set(path, promise);
  return promise;
}

export function clearPhotoCache(): void {
  memoryCache.clear();
  void FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
}

