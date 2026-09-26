import { Album } from '../types/album';

export const ALBUMS_DIRECTORY = '/Albums';
export const ALBUM_FILE_SUFFIX = '.album.json';

/** Bumped only when the on-disk shape changes in a way older readers can't handle. */
const ALBUM_FORMAT_VERSION = 1;

type AlbumFile = {
  fluxAlbum?: number;
  id?: unknown;
  title?: unknown;
  description?: unknown;
  photoPaths?: unknown;
  coverPath?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createAlbumId(): string {
  return `album_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createAlbumFileName(title: string, id: string): string {
  const slug = title.trim().toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return `${slug || 'album'}-${id}${ALBUM_FILE_SUFFIX}`;
}

export function serializeAlbum(album: Album): string {
  const payload = {
    fluxAlbum: ALBUM_FORMAT_VERSION,
    id: album.id,
    title: album.title,
    description: album.description,
    coverPath: album.coverPath,
    photoPaths: album.photoPaths,
    createdAt: album.createdAt,
    updatedAt: album.updatedAt,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Parses an album manifest. Throws when the file is not a Flux album. */
export function parseAlbum(rawText: string, filePath: string, fallbackDate: number): Album {
  let parsed: AlbumFile;
  try {
    parsed = JSON.parse(rawText) as AlbumFile;
  } catch {
    throw new Error('Album file is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.fluxAlbum !== 'number') {
    throw new Error('Album file is missing its "fluxAlbum" marker');
  }
  if (parsed.fluxAlbum > ALBUM_FORMAT_VERSION) {
    throw new Error('Album file was written by a newer version of Flux Photos');
  }

  const fileName = filePath.split('/').pop() || '';
  const id = asString(parsed.id)
    || fileName.replace(new RegExp(`${ALBUM_FILE_SUFFIX.replace('.', '\\.')}$`, 'i'), '')
    || createAlbumId();
  const photoPaths = Array.isArray(parsed.photoPaths)
    ? Array.from(new Set(parsed.photoPaths.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)))
    : [];
  const coverPath = asString(parsed.coverPath) || null;
  const createdAt = asTimestamp(parsed.createdAt, fallbackDate);

  return {
    id,
    title: asString(parsed.title) || 'Untitled album',
    description: asString(parsed.description),
    photoPaths,
    coverPath: coverPath && photoPaths.includes(coverPath) ? coverPath : photoPaths[0] ?? null,
    createdAt,
    updatedAt: asTimestamp(parsed.updatedAt, createdAt),
    path: filePath,
  };
}
