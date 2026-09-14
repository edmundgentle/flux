import { Linking } from 'react-native';
import {
  ContactItem,
  PhoneItem,
  EmailItem,
  AddressItem,
  SocialProfileItem,
} from '../types/contact';

const AVATAR_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#14b8a6', '#6366f1', '#d97706',
];

export function isRawIdString(str?: string): boolean {
  if (!str) return false;
  const trimmed = str.trim();
  // Check if string matches raw filenames or system ID formats like contact_123, contact-abc, UUIDs, numeric timestamps
  return (
    /^contact[_\-\s]/i.test(trimmed) ||
    /^note[_\-\s]/i.test(trimmed) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ||
    /^\d{10,}$/.test(trimmed)
  );
}

export function getDisplayName(contact: Partial<ContactItem>): string {
  const first = isRawIdString(contact.firstName) ? '' : (contact.firstName || '').trim();
  const middle = isRawIdString(contact.middleName) ? '' : (contact.middleName || '').trim();
  const last = (isRawIdString(contact.surname) || isRawIdString(contact.lastName))
    ? ''
    : (contact.surname || contact.lastName || '').trim();

  const nameParts = [first, middle, last].filter(Boolean);
  if (nameParts.length > 0) {
    return nameParts.join(' ');
  }

  // If explicitly provided and not a raw random ID
  if (contact.displayName && !isRawIdString(contact.displayName)) {
    return contact.displayName.trim();
  }

  if (contact.company && !isRawIdString(contact.company)) return contact.company.trim();
  if (contact.emails && contact.emails.length > 0 && contact.emails[0].email) {
    return contact.emails[0].email.trim();
  }
  if (contact.phones && contact.phones.length > 0 && contact.phones[0].number) {
    return contact.phones[0].number.trim();
  }

  return 'Unnamed Contact';
}

export function getInitials(contact: Partial<ContactItem>): string {
  const first = isRawIdString(contact.firstName) ? '' : (contact.firstName || '').trim();
  const middle = isRawIdString(contact.middleName) ? '' : (contact.middleName || '').trim();
  const last = (isRawIdString(contact.surname) || isRawIdString(contact.lastName))
    ? ''
    : (contact.surname || contact.lastName || '').trim();
  const company = isRawIdString(contact.company) ? '' : (contact.company || '').trim();
  const displayName = isRawIdString(contact.displayName) ? '' : (contact.displayName || '').trim();

  if (first && last) return `${first[0]}${last[0]}`.toUpperCase();
  if (first && middle) return `${first[0]}${middle[0]}`.toUpperCase();
  if (first) return first[0].toUpperCase();
  if (last) return last[0].toUpperCase();
  if (company) return company[0].toUpperCase();
  if (displayName && displayName !== 'Unnamed Contact') return displayName[0].toUpperCase();
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

    let firstName = (data.firstName || data.first_name || data.givenName || data.given_name || '').trim();
    let middleName = (data.middleName || data.middle_name || data.middleNames || '').trim();
    let surname = (data.surname || data.lastName || data.last_name || data.familyName || data.family_name || '').trim();
    let company = (data.company || data.org || '').trim();
    const jobTitle = (data.jobTitle || data.job_title || data.title || '').trim();

    if (isRawIdString(firstName)) firstName = '';
    if (isRawIdString(middleName)) middleName = '';
    if (isRawIdString(surname)) surname = '';
    if (isRawIdString(company)) company = '';

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

    const socialProfiles: SocialProfileItem[] = Array.isArray(data.socialProfiles || data.socials || data.social_profiles)
      ? (data.socialProfiles || data.socials || data.social_profiles).map((s: any, idx: number) => ({
          id: s.id || `s_${idx}`,
          platform: s.platform || 'Website',
          username: s.username || s.handle || s.url || '',
          url: s.url || '',
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

    const displayName = getDisplayName({
      firstName,
      middleName,
      surname,
      company,
      emails,
      phones,
      displayName: data.displayName || data.name,
    });

    const item: ContactItem = {
      id,
      firstName,
      middleName,
      surname,
      lastName: surname,
      displayName,
      company,
      jobTitle,
      phones,
      emails,
      socialProfiles,
      addresses,
      notes: data.notes || data.note || '',
      birthday: data.birthday || data.bday || '',
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
    const cleanName = isRawIdString(fallbackName) ? '' : fallbackName;
    const displayName = cleanName || 'Unnamed Contact';
    return {
      id: `contact_${Date.now()}`,
      firstName: cleanName,
      middleName: '',
      surname: '',
      lastName: '',
      displayName,
      phones: [],
      emails: [],
      socialProfiles: [],
      addresses: [],
      createdAt: fallbackDate,
      updatedAt: fallbackDate,
      path: filePath,
    };
  }
}

export function serializeContactJson(contact: ContactItem): string {
  const surnameVal = (contact.surname || contact.lastName || '').trim();
  const exportable = {
    id: contact.id,
    firstName: (contact.firstName || '').trim(),
    middleName: (contact.middleName || '').trim(),
    surname: surnameVal,
    lastName: surnameVal,
    displayName: getDisplayName(contact),
    company: (contact.company || '').trim(),
    jobTitle: (contact.jobTitle || '').trim(),
    phones: (contact.phones || []).map((p) => ({ id: p.id, label: (p.label || '').trim(), number: (p.number || '').trim() })),
    emails: (contact.emails || []).map((e) => ({ id: e.id, label: (e.label || '').trim(), email: (e.email || '').trim() })),
    socialProfiles: (contact.socialProfiles || []).map((s) => ({
      id: s.id,
      platform: (s.platform || '').trim(),
      username: (s.username || '').trim(),
      url: (s.url || '').trim(),
    })),
    addresses: (contact.addresses || []).map((a) => ({
      id: a.id,
      label: (a.label || '').trim(),
      street: (a.street || '').trim(),
      city: (a.city || '').trim(),
      state: (a.state || '').trim(),
      zip: (a.zip || '').trim(),
      country: (a.country || '').trim(),
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
  const surname = contact.surname || contact.lastName || '';
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${surname};${contact.firstName || ''};${contact.middleName || ''};;`,
    `FN:${getDisplayName(contact)}`,
  ];

  if (contact.company) lines.push(`ORG:${contact.company}`);
  if (contact.jobTitle) lines.push(`TITLE:${contact.jobTitle}`);

  for (const p of contact.phones || []) {
    lines.push(`TEL;TYPE=${p.label.toUpperCase()}:${p.number}`);
  }

  for (const e of contact.emails || []) {
    lines.push(`EMAIL;TYPE=${e.label.toUpperCase()}:${e.email}`);
  }

  for (const s of contact.socialProfiles || []) {
    lines.push(`X-SOCIALPROFILE;TYPE=${s.platform.toUpperCase()}:${s.url || s.username}`);
  }

  for (const a of contact.addresses || []) {
    lines.push(`ADR;TYPE=${a.label.toUpperCase()}:;;${a.street};${a.city};${a.state};${a.zip};${a.country}`);
  }

  if (contact.notes) lines.push(`NOTE:${contact.notes.replace(/\n/g, '\\n')}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday}`);

  lines.push('END:VCARD');
  return lines.join('\r\n');
}

export function parseVCard(vcardText: string): Partial<ContactItem> {
  const lines = vcardText.split(/\r?\n/);
  let firstName = '';
  let middleName = '';
  let surname = '';
  let displayName = '';
  let company = '';
  let jobTitle = '';
  let notes = '';
  let birthday = '';
  const phones: PhoneItem[] = [];
  const emails: EmailItem[] = [];
  const socialProfiles: SocialProfileItem[] = [];
  const addresses: AddressItem[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('BEGIN:') || trimmed.startsWith('END:') || trimmed.startsWith('VERSION:')) {
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const keyPart = trimmed.substring(0, colonIdx);
    const valuePart = trimmed.substring(colonIdx + 1).trim();

    if (keyPart.startsWith('N') && !keyPart.startsWith('NOTE')) {
      const parts = valuePart.split(';');
      surname = parts[0] || '';
      firstName = parts[1] || '';
      middleName = parts[2] || '';
    } else if (keyPart.startsWith('FN')) {
      displayName = valuePart;
    } else if (keyPart.startsWith('ORG')) {
      company = valuePart;
    } else if (keyPart.startsWith('TITLE')) {
      jobTitle = valuePart;
    } else if (keyPart.startsWith('NOTE')) {
      notes = valuePart.replace(/\\n/g, '\n');
    } else if (keyPart.startsWith('BDAY')) {
      birthday = valuePart;
    } else if (keyPart.startsWith('TEL')) {
      let label = 'Mobile';
      if (keyPart.includes('WORK')) label = 'Work';
      else if (keyPart.includes('HOME')) label = 'Home';
      else if (keyPart.includes('MAIN')) label = 'Main';
      phones.push({ id: `p_${Date.now()}_${phones.length}`, label, number: valuePart });
    } else if (keyPart.startsWith('EMAIL')) {
      let label = 'Personal';
      if (keyPart.includes('WORK')) label = 'Work';
      emails.push({ id: `e_${Date.now()}_${emails.length}`, label, email: valuePart });
    } else if (keyPart.startsWith('X-SOCIALPROFILE') || keyPart.startsWith('URL')) {
      let platform = 'Website';
      if (keyPart.includes('TWITTER') || valuePart.includes('twitter.com') || valuePart.includes('x.com')) platform = 'Twitter';
      else if (keyPart.includes('LINKEDIN') || valuePart.includes('linkedin.com')) platform = 'LinkedIn';
      else if (keyPart.includes('GITHUB') || valuePart.includes('github.com')) platform = 'GitHub';
      else if (keyPart.includes('INSTAGRAM') || valuePart.includes('instagram.com')) platform = 'Instagram';
      else if (keyPart.includes('FACEBOOK') || valuePart.includes('facebook.com')) platform = 'Facebook';
      else if (keyPart.includes('TELEGRAM') || valuePart.includes('t.me')) platform = 'Telegram';
      else if (keyPart.includes('WHATSAPP') || valuePart.includes('wa.me')) platform = 'WhatsApp';

      socialProfiles.push({
        id: `s_${Date.now()}_${socialProfiles.length}`,
        platform,
        username: valuePart.replace(/^https?:\/\/[^/]+\//, '@'),
        url: valuePart.startsWith('http') ? valuePart : undefined,
      });
    } else if (keyPart.startsWith('ADR')) {
      const parts = valuePart.split(';');
      addresses.push({
        id: `a_${Date.now()}_${addresses.length}`,
        label: keyPart.includes('WORK') ? 'Work' : 'Home',
        street: parts[2] || '',
        city: parts[3] || '',
        state: parts[4] || '',
        zip: parts[5] || '',
        country: parts[6] || '',
      });
    }
  }

  return {
    firstName,
    middleName,
    surname,
    lastName: surname,
    displayName: displayName || getDisplayName({ firstName, middleName, surname, company }),
    company,
    jobTitle,
    notes,
    birthday,
    phones,
    emails,
    socialProfiles,
    addresses,
  };
}

export async function openSocialDeepLink(platform: string, username: string, customUrl?: string): Promise<void> {
  const cleanHandle = username.replace(/^@/, '').trim();
  let primaryAppUrl = '';
  let fallbackWebUrl = customUrl || '';

  const lowerPlatform = platform.toLowerCase();

  if (lowerPlatform === 'twitter' || lowerPlatform === 'x') {
    primaryAppUrl = `twitter://user?screen_name=${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://x.com/${cleanHandle}`;
  } else if (lowerPlatform === 'linkedin') {
    primaryAppUrl = `linkedin://in/${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://www.linkedin.com/in/${cleanHandle}`;
  } else if (lowerPlatform === 'github') {
    primaryAppUrl = `https://github.com/${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://github.com/${cleanHandle}`;
  } else if (lowerPlatform === 'instagram') {
    primaryAppUrl = `instagram://user?username=${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://instagram.com/${cleanHandle}`;
  } else if (lowerPlatform === 'facebook') {
    primaryAppUrl = `fb://profile/${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://facebook.com/${cleanHandle}`;
  } else if (lowerPlatform === 'telegram') {
    primaryAppUrl = `tg://resolve?domain=${cleanHandle}`;
    fallbackWebUrl = fallbackWebUrl || `https://t.me/${cleanHandle}`;
  } else if (lowerPlatform === 'whatsapp') {
    const numOnly = cleanHandle.replace(/[^0-9]/g, '');
    primaryAppUrl = `whatsapp://send?phone=${numOnly}`;
    fallbackWebUrl = fallbackWebUrl || `https://wa.me/${numOnly || cleanHandle}`;
  } else {
    fallbackWebUrl = fallbackWebUrl || (username.startsWith('http') ? username : `https://${username}`);
  }

  if (primaryAppUrl) {
    try {
      const canOpen = await Linking.canOpenURL(primaryAppUrl);
      if (canOpen) {
        await Linking.openURL(primaryAppUrl);
        return;
      }
    } catch {
      // Ignore app link error and fallback to web URL
    }
  }

  if (fallbackWebUrl) {
    await Linking.openURL(fallbackWebUrl);
  }
}

export async function openPhoneDeepLink(phoneNumber: string, type: 'call' | 'sms' = 'call'): Promise<void> {
  const cleanNumber = phoneNumber.replace(/\s+/g, '');
  const scheme = type === 'sms' ? 'sms:' : 'tel:';
  await Linking.openURL(`${scheme}${cleanNumber}`);
}

export function groupContactsAlphabetically(contacts: ContactItem[]): { letter: string; data: ContactItem[] }[] {
  const groups: Record<string, ContactItem[]> = {};

  for (const c of contacts) {
    const key = (c.surname || c.lastName || c.firstName || c.company || c.displayName || '#')
      .trim()
      .charAt(0)
      .toUpperCase();
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

