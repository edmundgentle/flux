import AsyncStorage from '@react-native-async-storage/async-storage';
import { ContactItem } from '../types/contact';

const CACHE_KEY = '@flux_people_cached_contacts';

export async function getCachedContacts(): Promise<ContactItem[]> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((contact) => typeof contact?.path === 'string' && /\.vcf$/i.test(contact.path)) : [];
  } catch {
    return [];
  }
}

export async function saveCachedContacts(contacts: ContactItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(contacts));
  } catch (err) {
    console.warn('Failed to save contacts to local cache:', err);
  }
}

export async function upsertCachedContact(contact: ContactItem): Promise<ContactItem[]> {
  const contacts = await getCachedContacts();
  const index = contacts.findIndex((c) => c.id === contact.id || c.path === contact.path);

  let updated: ContactItem[];
  if (index >= 0) {
    updated = [...contacts];
    updated[index] = contact;
  } else {
    updated = [contact, ...contacts];
  }

  await saveCachedContacts(updated);
  return updated;
}

export async function deleteCachedContact(id: string): Promise<ContactItem[]> {
  const contacts = await getCachedContacts();
  const updated = contacts.filter((c) => c.id !== id && c.path !== id);
  await saveCachedContacts(updated);
  return updated;
}

export function searchCachedContacts(
  contacts: ContactItem[],
  query: string,
  selectedTag?: string | null
): ContactItem[] {
  let filtered = contacts;

  if (selectedTag) {
    if (selectedTag === 'Favorites') {
      filtered = filtered.filter((c) => c.favorite);
    } else {
      filtered = filtered.filter((c) => c.tags && c.tags.includes(selectedTag));
    }
  }

  const q = query.trim().toLowerCase();
  if (!q) {
    return filtered;
  }

  return filtered.filter((contact) => {
    const fullName = `${contact.firstName || ''} ${contact.middleName || ''} ${contact.surname || contact.lastName || ''} ${contact.displayName || ''}`.toLowerCase();
    if (fullName.includes(q)) return true;

    if (contact.company && contact.company.toLowerCase().includes(q)) return true;
    if (contact.jobTitle && contact.jobTitle.toLowerCase().includes(q)) return true;
    if (contact.notes && contact.notes.toLowerCase().includes(q)) return true;

    if (contact.phones && contact.phones.some((p) => p.number.replace(/\s+/g, '').includes(q))) return true;
    if (contact.emails && contact.emails.some((e) => e.email.toLowerCase().includes(q))) return true;
    if (
      contact.socialProfiles &&
      contact.socialProfiles.some((s) => s.username.toLowerCase().includes(q) || s.platform.toLowerCase().includes(q))
    )
      return true;
    if (contact.tags && contact.tags.some((t) => t.toLowerCase().includes(q))) return true;

    return false;
  });
}
