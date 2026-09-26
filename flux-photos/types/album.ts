export type Album = {
  id: string;
  title: string;
  description: string;
  /** Workspace paths of the photos in the album, in display order. */
  photoPaths: string[];
  /** Photo path used as the album cover; falls back to the first photo when null. */
  coverPath: string | null;
  createdAt: number;
  updatedAt: number;
  /** Path of the album manifest file itself. */
  path: string;
  /** Server modification time of the manifest, used to skip unchanged downloads. */
  serverModifiedAt?: number;
};
