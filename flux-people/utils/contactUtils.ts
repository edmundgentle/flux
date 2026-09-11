import { ContactItem, PhoneItem, EmailItem, AddressItem } from '../types/contact';

const AVATAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#14b8a6', '#6366f1', '#d97706',
];

export function getDisplayName(contact: Partial<ContactItem>): string {
  const first = (contact.firstName || '').trim();
  const last = (contact.lastName || '').trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (contact.company) return contact.company.trim();
  return 'Unnamed Contact';
}

export function getInitials(contact: Partial<ContactItem>): string {
  const first = (contact.firstName || '').trim();
  const last = (contact.lastName || '').trim();
  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  if (first) return first[0].toUpperCase();
  if (last) return last[0].toUpperCase();
  if (contact.company) return contact.company[0].toUpperCase();
  return '?';
}

export function getAvatarBgColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % AVATAR_COLORS.length;
  return AVATAR_COLORS[index];
}

export function parseContactJson(rawText: string, filePath: string, fallbackDate: number): ContactItem {
  try {
    const data = JSON.parse(rawText);
    const id = data.id || filePath.split('/').pop()?.replace('.json', '') || `contact_${Date.now()}`;
    const firstName = data.firstName || data.first_name || '';
    const lastName = data.lastName || data.last_name || '';
    const company = data.company || '';
    const jobTitle = data.jobTitle || data.job_title || '';
    
    const phones: PhoneItem[] = Array.isArray(data.phones)
      ? data.phones.map((p: any, idx: number) => ({
          id: p.id || `p_${idx}`,
          label: p.label || 'Mobile',
          number: p.number || p.phone || '',
        }))
      : [];

    const emails: EmailItem[] = Array.isArray(data.emails)
      ? data.emails.map((e: any, idx: number) => ({
          id: e.id || `e_${idx}`,
          label: e.label || 'Personal',
          email: e.email || '',
        }))
      : [];

    const addresses: AddressItem[] = Array.isArray(data.addresses)
      ? data.addresses.map((a: any, idx: number) => ({
          id: a.id || `a_${idx}`,
          label: a.label || 'Home',
          street: a.street || '',
          city: a.city || '',
          state: a.state || '',
          zip: a.zip || a.postalCode || '',
          country: a.country || '',
        }))
      : [];

    const tags: string[] = Array.isArray(data.tags) ? data.tags : [];

    const item: ContactItem = {
      id,
      firstName,
      lastName,
      displayName: getDisplayName({ firstName, lastName, company }),
      company,
      jobTitle,
      phones,
      emails,
      addresses,
      notes: data.notes || '',
      birthday: data.birthday || '',
      tags,
      favorite: Boolean(data.favorite || data.isFavorite),
      avatarUrl: data.avatarUrl || data.photoUrl || '',
      createdAt: data.createdAt || fallbackDate,
      updatedAt: data.updatedAt || fallbackDate,
      path: filePath,
    };

    return item;
  } catch {
    const fileName = filePath.split('/').pop() || 'Contact';
    const fallbackName = fileName.replace('.json', '');
    return {
      id: `contact_${Date.now()}`,
      firstName: fallbackName,
      lastName: '',
      displayName: fallbackName,
      phones: [],
      emails: [],
      addresses: [],
      createdAt: fallbackDate,
      updatedAt: fallbackDate,
      path: filePath,
    };
  }
}

export function serializeContactJson(contact: ContactItem): string {
  const exportable = {
    id: contact.id,
    firstName: contact.firstName.trim(),
    lastName: contact.lastName.trim(),
    displayName: getDisplayName(contact),
    company: (contact.company || '').trim(),
    jobTitle: (contact.jobTitle || '').trim(),
    phones: contact.phones.map((p) => ({ id: p.id, label: p.label.trim(), number: p.number.trim() })),
    emails: contact.emails.map((e) => ({ id: e.id, label: e.label.trim(), email: e.email.trim() })),
    addresses: contact.addresses.map((a) => ({
      id: a.id,
      label: a.label.trim(),
      street: a.street.trim(),
      city: a.city.trim(),
      state: a.state.trim(),
      zip: a.zip.trim(),
      country: a.country.trim(),
    })),
    notes: (contact.notes || '').trim(),
    birthday: (contact.birthday || '').trim(),
    tags: contact.tags || [],
    favorite: Boolean(contact.favorite),
    avatarUrl: contact.avatarUrl || '',
    createdAt: contact.createdAt || Date.now(),
    updatedAt: Date.now(),
    path: contact.path,
  };

  return JSON.stringify(exportable, null, 2);
}

export function generateVCard(contact: ContactItem): string {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${contact.lastName};${contact.firstName};;;`,
    `FN:${contact.displayName}`,
  ];

  if (contact.company) lines.push(`ORG:${contact.company}`);
  if (contact.jobTitle) lines.push(`TITLE:${contact.jobTitle}`);

  for (const p of contact.phones) {
    lines.push(`TEL;TYPE=${p.label.toUpperCase()}:${p.number}`);
  }

  for (const e of contact.emails) {
    lines.push(`EMAIL;TYPE=${e.label.toUpperCase()}:${e.email}`);
  }

  for (const a of contact.addresses) {
    lines.push(`ADR;TYPE=${a.label.toUpperCase()}:;;${a.street};${a.city};${a.state};${a.zip};${a.country}`);
  }

  if (contact.notes) lines.push(`NOTE:${contact.notes.replace(/\n/g, '\\n')}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function groupContactsAlphabetically(contacts: ContactItem[]): { letter: string; data: ContactItem[] }[] {
  const groups: Record<string, ContactItem[]> = {};

  for (const c of contacts) {
    const key = (c.lastName || c.firstName || c.company || '#').trim().charAt(0).toUpperCase();
    const letter = /[A-Z]/.test(key) ? key : '#';
    if (!groups[letter]) groups[letter] = [];
    groups[letter].push(c);
  }

  const letters = Object.keys(groups).sort((a, b) => {
    if (a === '#') return 1;
    if (b === '#') return -1;
    return a.localeCompare(b);
  });

  return letters.map((letter) => ({
    letter,
    data: groups[letter].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  }));
}
