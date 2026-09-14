export type PhoneLabel = 'Mobile' | 'Work' | 'Home' | 'Main' | 'Other';
export type EmailLabel = 'Personal' | 'Work' | 'Other';
export type AddressLabel = 'Home' | 'Work' | 'Other';

export type PhoneItem = {
  id: string;
  label: PhoneLabel | string;
  number: string;
};

export type EmailItem = {
  id: string;
  label: EmailLabel | string;
  email: string;
};

export type AddressItem = {
  id: string;
  label: AddressLabel | string;
  street: string;
  city: string;
  state: string;
  zip: string;
  country: string;
};

export type SocialPlatform =
  | 'Twitter'
  | 'LinkedIn'
  | 'GitHub'
  | 'Instagram'
  | 'Facebook'
  | 'Telegram'
  | 'WhatsApp'
  | 'Website'
  | string;

export type SocialProfileItem = {
  id: string;
  platform: SocialPlatform;
  username: string;
  url?: string;
};

export type ContactItem = {
  id: string;
  firstName: string;
  middleName?: string;
  surname?: string;
  lastName: string;
  displayName: string;
  company?: string;
  jobTitle?: string;
  phones: PhoneItem[];
  emails: EmailItem[];
  socialProfiles?: SocialProfileItem[];
  addresses: AddressItem[];
  notes?: string;
  birthday?: string;
  tags?: string[];
  favorite?: boolean;
  avatarUrl?: string;
  createdAt: number;
  updatedAt: number;
  path: string;
};

