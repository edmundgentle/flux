import AsyncStorage from '@react-native-async-storage/async-storage';
import { NoteItem } from '../types/note';

const CACHE_KEY = '@flux_notes_cached_notes';

export async function getCachedNotes(): Promise<NoteItem[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    const notes = raw ? JSON.parse(raw) : [];
    return Array.isArray(notes) ? notes : [];
  } catch {
    return [];
  }
}

export async function saveCachedNotes(notes: NoteItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(notes));
  } catch (error) {
    console.warn('Unable to cache notes:', error);
  }
}

export function searchCachedNotes(notes: NoteItem[], query: string): NoteItem[] {
  const term = query.trim().toLowerCase();
  if (!term) return notes;
  return notes.filter((note) => [note.title, note.content, ...(note.labels || [])]
    .some((value) => value.toLowerCase().includes(term)));
}

export async function upsertCachedNote(note: NoteItem): Promise<NoteItem[]> {
  const current = await getCachedNotes();
  const index = current.findIndex((item) => item.id === note.id || item.path === note.path);
  const updated = index === -1
    ? [note, ...current]
    : current.map((item, itemIndex) => itemIndex === index ? note : item);
  await saveCachedNotes(updated);
  return updated;
}

export async function deleteCachedNote(note: NoteItem): Promise<NoteItem[]> {
  const current = await getCachedNotes();
  const updated = current.filter((item) => item.id !== note.id && item.path !== note.path);
  await saveCachedNotes(updated);
  return updated;
}
