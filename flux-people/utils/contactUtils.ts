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

export function getContactFileName(contact: Partial<ContactItem> & { id: string }): string {
  const name = getDisplayName(contact)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  const slug = Array.from(name).slice(0, 60).join('').replace(/-$/g, '') || 'contact';
  const id = Array.from(contact.id).map((char) => /[a-zA-Z0-9_-]/.test(char) ? char : `%${char.codePointAt(0)!.toString(16)}%`).join('');
  return `${slug}-${id}.vcf`;
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

function escapeVCard(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function unescapeVCard(value: string): string {
  return value.replace(/\\([nN\\;,])/g, (_, char: string) => char.toLowerCase() === 'n' ? '\n' : char);
}

function splitVCard(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\' && index + 1 < value.length) {
      current += value[index] + value[++index];
    } else if (value[index] === separator) {
      parts.push(unescapeVCard(current));
      current = '';
    } else {
      current += value[index];
    }
  }
  parts.push(unescapeVCard(current));
  return parts;
}

function foldVCardLine(line: string): string {
  const encoder = new TextEncoder();
  let result = '';
  let bytesOnLine = 0;
  for (const char of line) {
    const width = encoder.encode(char).length;
    if (bytesOnLine + width > 75) {
      result += '\r\n ';
      bytesOnLine = 1;
    }
    result += char;
    bytesOnLine += width;
  }
  return result;
}

export function generateVCard(contact: ContactItem): string {
  const escape = escapeVCard;
  const surname = contact.surname || contact.lastName || '';
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:${escape(surname)};${escape(contact.firstName || '')};${escape(contact.middleName || '')};;`,
    `FN:${escape(getDisplayName(contact))}`,
    `UID:${escape(contact.id)}`,
    `X-FLUX-CREATED-AT:${contact.createdAt}`,
    `X-FLUX-UPDATED-AT:${contact.updatedAt}`,
    `X-FLUX-FAVORITE:${contact.favorite ? 'TRUE' : 'FALSE'}`,
  ];

  if (contact.company) lines.push(`ORG:${escape(contact.company)}`);
  if (contact.jobTitle) lines.push(`TITLE:${escape(contact.jobTitle)}`);

  for (const p of contact.phones || []) {
    lines.push(`TEL;TYPE=${escape(p.label.toUpperCase())};X-FLUX-ID=${escape(p.id)}:${escape(p.number)}`);
  }

  for (const e of contact.emails || []) {
    lines.push(`EMAIL;TYPE=${escape(e.label.toUpperCase())};X-FLUX-ID=${escape(e.id)}:${escape(e.email)}`);
  }

  for (const s of contact.socialProfiles || []) {
    lines.push(`X-SOCIALPROFILE;TYPE=${escape(s.platform.toUpperCase())};X-FLUX-ID=${escape(s.id)}:${escape(s.url || s.username)}`);
    if (s.username && s.url) lines.push(`X-FLUX-SOCIAL-USERNAME:${escape(s.username)}`);
  }

  for (const a of contact.addresses || []) {
    lines.push(`ADR;TYPE=${escape(a.label.toUpperCase())};X-FLUX-ID=${escape(a.id)}:;;${[a.street, a.city, a.state, a.zip, a.country].map((part) => escape(part)).join(';')}`);
  }

  if (contact.notes) lines.push(`NOTE:${escape(contact.notes)}`);
  if (contact.birthday) lines.push(`BDAY:${escape(contact.birthday)}`);
  if (contact.avatarUrl) lines.push(`PHOTO;VALUE=URI:${escape(contact.avatarUrl)}`);
  for (const tag of contact.tags || []) lines.push(`CATEGORIES:${escape(tag)}`);

  lines.push('END:VCARD');
  return lines.map(foldVCardLine).join('\r\n') + '\r\n';
}

export function parseVCard(vcardText: string): Partial<ContactItem> {
  const lines = vcardText.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let id = '';
  let firstName = '';
  let middleName = '';
  let surname = '';
  let displayName = '';
  let company = '';
  let jobTitle = '';
  let notes = '';
  let birthday = '';
  let avatarUrl = '';
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  let favorite = false;
  const tags: string[] = [];
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
    const [property, ...parameters] = keyPart.split(';');
    const field = property.toUpperCase();
    const type = parameters.find((parameter) => parameter.toUpperCase().startsWith('TYPE='))?.slice(5).toUpperCase() || '';
    const fieldId = parameters.find((parameter) => parameter.toUpperCase().startsWith('X-FLUX-ID='))?.slice(10);
    const valuePart = unescapeVCard(trimmed.substring(colonIdx + 1).trim());

    if (field === 'N') {
      const parts = splitVCard(trimmed.substring(colonIdx + 1), ';');
      surname = parts[0] || '';
      firstName = parts[1] || '';
      middleName = parts[2] || '';
    } else if (field === 'FN') {
      displayName = valuePart;
    } else if (field === 'UID') {
      id = valuePart;
    } else if (field === 'ORG') {
      company = valuePart;
    } else if (field === 'TITLE') {
      jobTitle = valuePart;
    } else if (field === 'NOTE') {
      notes = valuePart;
    } else if (field === 'BDAY') {
      birthday = valuePart;
    } else if (field === 'PHOTO') {
      avatarUrl = valuePart;
    } else if (field === 'X-FLUX-CREATED-AT') {
      createdAt = Number(valuePart) || undefined;
    } else if (field === 'X-FLUX-UPDATED-AT') {
      updatedAt = Number(valuePart) || undefined;
    } else if (field === 'X-FLUX-FAVORITE') {
      favorite = valuePart.toUpperCase() === 'TRUE';
    } else if (field === 'CATEGORIES') {
      tags.push(...splitVCard(trimmed.substring(colonIdx + 1), ','));
    } else if (field === 'TEL') {
      let label = 'Mobile';
      if (type.includes('WORK')) label = 'Work';
      else if (type.includes('HOME')) label = 'Home';
      else if (type.includes('MAIN')) label = 'Main';
      else if (type.includes('OTHER')) label = 'Other';
      phones.push({ id: fieldId || `p_${phones.length}`, label, number: valuePart });
    } else if (field === 'EMAIL') {
      let label = 'Personal';
      if (type.includes('WORK')) label = 'Work';
      else if (type.includes('OTHER')) label = 'Other';
      emails.push({ id: fieldId || `e_${emails.length}`, label, email: valuePart });
    } else if (field === 'X-SOCIALPROFILE' || field === 'URL') {
      let platform = type ? type.charAt(0) + type.slice(1).toLowerCase() : 'Website';
      if (type.includes('TWITTER') || valuePart.includes('twitter.com') || valuePart.includes('x.com')) platform = 'Twitter';
      else if (keyPart.includes('LINKEDIN') || valuePart.includes('linkedin.com')) platform = 'LinkedIn';
      else if (keyPart.includes('GITHUB') || valuePart.includes('github.com')) platform = 'GitHub';
      else if (keyPart.includes('INSTAGRAM') || valuePart.includes('instagram.com')) platform = 'Instagram';
      else if (keyPart.includes('FACEBOOK') || valuePart.includes('facebook.com')) platform = 'Facebook';
      else if (keyPart.includes('TELEGRAM') || valuePart.includes('t.me')) platform = 'Telegram';
      else if (keyPart.includes('WHATSAPP') || valuePart.includes('wa.me')) platform = 'WhatsApp';

      socialProfiles.push({
        id: fieldId || `s_${socialProfiles.length}`,
        platform,
        username: valuePart.replace(/^https?:\/\/[^/]+\//, '@'),
        url: valuePart.startsWith('http') ? valuePart : undefined,
      });
    } else if (field === 'X-FLUX-SOCIAL-USERNAME') {
      if (socialProfiles.length) socialProfiles[socialProfiles.length - 1].username = valuePart;
    } else if (field === 'ADR') {
      const parts = splitVCard(trimmed.substring(colonIdx + 1), ';');
      addresses.push({
        id: fieldId || `a_${addresses.length}`,
        label: type.includes('WORK') ? 'Work' : type.includes('OTHER') ? 'Other' : 'Home',
        street: parts[2] || '',
        city: parts[3] || '',
        state: parts[4] || '',
        zip: parts[5] || '',
        country: parts[6] || '',
      });
    }
  }

  return {
    id,
    firstName,
    middleName,
    surname,
    lastName: surname,
    displayName: displayName || getDisplayName({ firstName, middleName, surname, company }),
    company,
    jobTitle,
    notes,
    birthday,
    avatarUrl,
    createdAt,
    updatedAt,
    favorite,
    tags,
    phones,
    emails,
    socialProfiles,
    addresses,
  };
}

export function parseContactVCard(rawText: string, filePath: string, fallbackDate: number): ContactItem {
  if (!/^BEGIN:VCARD\s*$/im.test(rawText) || !/^END:VCARD\s*$/im.test(rawText)) {
    throw new Error('Invalid vCard file');
  }
  const parsed = parseVCard(rawText);
  const id = parsed.id || filePath.split('/').pop()?.replace(/\.vcf$/i, '') || `contact_${Date.now()}`;
  return {
    ...parsed,
    id,
    firstName: parsed.firstName || '',
    lastName: parsed.surname || parsed.lastName || '',
    displayName: getDisplayName(parsed),
    phones: parsed.phones || [],
    emails: parsed.emails || [],
    socialProfiles: parsed.socialProfiles || [],
    addresses: parsed.addresses || [],
    createdAt: parsed.createdAt || fallbackDate,
    updatedAt: parsed.updatedAt || fallbackDate,
    path: filePath,
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

