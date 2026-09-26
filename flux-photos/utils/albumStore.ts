import AsyncStorage from '@react-native-async-storage/async-storage';
import { FluxClient } from '@flux-sdk/core';
import { Album } from '../types/album';
import { ALBUMS_DIRECTORY, ALBUM_FILE_SUFFIX, createAlbumFileName, createAlbumId, parseAlbum, serializeAlbum } from './albumFile';

const CACHE_KEY = '@flux_photos_cached_albums';

function sortAlbums(albums: Album[]): Album[] {
  return [...albums].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
}

export async function getCachedAlbums(): Promise<Album[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveCachedAlbums(albums: Album[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(albums));
  } catch (error) {
    console.warn('Unable to cache albums:', error);
  }
}

export function createAlbum(title: string, photoPaths: string[] = []): Album {
  const timestamp = Date.now();
  const id = createAlbumId();
  const cleanTitle = title.trim() || 'Untitled album';
  return {
    id,
    title: cleanTitle,
    description: '',
    photoPaths,
    coverPath: photoPaths[0] ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    path: `${ALBUMS_DIRECTORY}/${createAlbumFileName(cleanTitle, id)}`,
  };
}

/**
 * Lists `/Albums` and downloads only the manifests whose server modification time differs from
 * the cached copy, so deletions are picked up without re-reading every album.
 */
export async function loadAlbums(client: FluxClient): Promise<Album[]> {
  const cached = await getCachedAlbums();
  const listing = await client.listFiles(ALBUMS_DIRECTORY);
  const albumFiles = listing.entries.filter(
    (entry) => !entry.is_dir && entry.name.toLowerCase().endsWith(ALBUM_FILE_SUFFIX),
  );
  const cachedByPath = new Map(cached.map((album) => [album.path, album]));

  const results = await Promise.all(albumFiles.map(async (entry) => {
    const previous = cachedByPath.get(entry.path);
    if (previous && entry.modified_at !== null && previous.serverModifiedAt === entry.modified_at) return previous;
    try {
      const text = await (await client.downloadFile(entry.path)).text();
      const parsed = parseAlbum(text, entry.path, entry.modified_at ?? Date.now());
      return { ...parsed, serverModifiedAt: entry.modified_at ?? undefined };
    } catch {
      return null;
    }
  }));

  const loaded = results.filter((album): album is Album => album !== null);
  const complete = !listing.truncated && loaded.length === albumFiles.length;
  if (complete) {
    const sorted = sortAlbums(loaded);
    await saveCachedAlbums(sorted);
    return sorted;
  }

  // A partial read must not drop an album that only exists locally yet.
  const merged = [
    ...loaded,
    ...cached.filter((album) => !loaded.some((server) => server.id === album.id || server.path === album.path)),
  ];
  return sortAlbums(merged);
}

/**
 * Writes the manifest to the instance and updates the local cache. The cache is updated first so
 * the UI stays responsive (and correct offline) even when the upload fails.
 */
export async function saveAlbum(client: FluxClient, album: Album, previousPath?: string): Promise<Album[]> {
  const updated: Album = { ...album, updatedAt: Date.now() };
  const cached = await getCachedAlbums();
  const next = sortAlbums([
    updated,
    ...cached.filter((item) => item.id !== updated.id && item.path !== updated.path && item.path !== previousPath),
  ]);
  await saveCachedAlbums(next);

  const fileName = updated.path.split('/').pop() || createAlbumFileName(updated.title, updated.id);
  const uploaded = await client.uploadFile(new TextEncoder().encode(serializeAlbum(updated)), {
    directory: ALBUMS_DIRECTORY,
    path: fileName,
  });
  if (previousPath && previousPath !== updated.path) {
    await client.deleteFile(previousPath);
  }

  // Adopt the absolute path the instance stored the manifest at, so later deletes/renames target it.
  if (uploaded.path && uploaded.path !== updated.path) {
    const withServerPath = next.map((item) => (item.id === updated.id ? { ...item, path: uploaded.path } : item));
    await saveCachedAlbums(withServerPath);
    return withServerPath;
  }
  return next;
}

export async function deleteAlbum(client: FluxClient, album: Album): Promise<Album[]> {
  const cached = await getCachedAlbums();
  const next = cached.filter((item) => item.id !== album.id && item.path !== album.path);
  await saveCachedAlbums(next);
  await client.deleteFile(album.path);
  return next;
}

/** Renames an album, keeping the manifest file name in step with the title. */
export function renameAlbum(album: Album, title: string): Album {
  const cleanTitle = title.trim() || 'Untitled album';
  const directory = album.path.slice(0, album.path.lastIndexOf('/')) || ALBUMS_DIRECTORY;
  return {
    ...album,
    title: cleanTitle,
    path: `${directory}/${createAlbumFileName(cleanTitle, album.id)}`,
  };
}

export function addPhotosToAlbum(album: Album, photoPaths: string[]): Album {
  const photos = Array.from(new Set([...album.photoPaths, ...photoPaths]));
  return { ...album, photoPaths: photos, coverPath: album.coverPath ?? photos[0] ?? null };
}

export function removePhotoFromAlbum(album: Album, photoPath: string): Album {
  const photos = album.photoPaths.filter((path) => path !== photoPath);
  return {
    ...album,
    photoPaths: photos,
    coverPath: album.coverPath === photoPath ? photos[0] ?? null : album.coverPath,
  };
}
