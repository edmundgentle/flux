export type ChecklistItem = {
  id: string;
  text: string;
  completed: boolean;
};

export type NoteColorId =
  | 'default'
  | 'coral'
  | 'peach'
  | 'sand'
  | 'mint'
  | 'sage'
  | 'fog'
  | 'dusk'
  | 'blossom'
  | 'clay'
  | 'charcoal'
  | 'lavender';

export type NoteColorTheme = {
  id: NoteColorId;
  name: string;
  bg: string;
  cardBg: string;
  border: string;
  text: string;
  secondaryText: string;
  badgeBg: string;
  accent: string;
};

export const NOTE_COLORS: Record<NoteColorId, NoteColorTheme> = {
  default: {
    id: 'default',
    name: 'Default',
    bg: '#ffffff',
    cardBg: '#ffffff',
    border: '#e2e8f0',
    text: '#0f172a',
    secondaryText: '#64748b',
    badgeBg: '#f1f5f9',
    accent: '#3b82f6',
  },
  coral: {
    id: 'coral',
    name: 'Coral',
    bg: '#faecea',
    cardBg: '#faecea',
    border: '#f5c6c0',
    text: '#7a1f1d',
    secondaryText: '#9b3d3a',
    badgeBg: '#f6d5d0',
    accent: '#d97706',
  },
  peach: {
    id: 'peach',
    name: 'Peach',
    bg: '#fbf0e4',
    cardBg: '#fbf0e4',
    border: '#f5d4b3',
    text: '#7c4100',
    secondaryText: '#9b5814',
    badgeBg: '#f6deca',
    accent: '#d97706',
  },
  sand: {
    id: 'sand',
    name: 'Sand',
    bg: '#fef9e7',
    cardBg: '#fef9e7',
    border: '#fce9a5',
    text: '#745400',
    secondaryText: '#96710c',
    badgeBg: '#fbf0b8',
    accent: '#eab308',
  },
  mint: {
    id: 'mint',
    name: 'Mint',
    bg: '#e6f4ea',
    cardBg: '#e6f4ea',
    border: '#bbf0c8',
    text: '#137333',
    secondaryText: '#1b803e',
    badgeBg: '#ceebd6',
    accent: '#16a34a',
  },
  sage: {
    id: 'sage',
    name: 'Sage',
    bg: '#e4f7f6',
    cardBg: '#e4f7f6',
    border: '#b4ece9',
    text: '#0d6562',
    secondaryText: '#187c78',
    badgeBg: '#cbf3f1',
    accent: '#0d9488',
  },
  fog: {
    id: 'fog',
    name: 'Fog',
    bg: '#e8f0fe',
    cardBg: '#e8f0fe',
    border: '#c2d7fe',
    text: '#1967d2',
    secondaryText: '#2373e8',
    badgeBg: '#d2e3fc',
    accent: '#2563eb',
  },
  dusk: {
    id: 'dusk',
    name: 'Dusk',
    bg: '#edf2fc',
    cardBg: '#edf2fc',
    border: '#cad8f8',
    text: '#1c4992',
    secondaryText: '#2a5ba8',
    badgeBg: '#d8e4fb',
    accent: '#4f46e5',
  },
  blossom: {
    id: 'blossom',
    name: 'Blossom',
    bg: '#f3e8fd',
    cardBg: '#f3e8fd',
    border: '#dcbeec',
    text: '#6b119e',
    secondaryText: '#8725c2',
    badgeBg: '#e6ccf7',
    accent: '#9333ea',
  },
  clay: {
    id: 'clay',
    name: 'Clay',
    bg: '#fce8e6',
    cardBg: '#fce8e6',
    border: '#f8bbb6',
    text: '#a50e0e',
    secondaryText: '#c5221f',
    badgeBg: '#fad2ce',
    accent: '#e11d48',
  },
  charcoal: {
    id: 'charcoal',
    name: 'Charcoal',
    bg: '#e9eef2',
    cardBg: '#e9eef2',
    border: '#cbd5e1',
    text: '#334155',
    secondaryText: '#475569',
    badgeBg: '#cbd5e1',
    accent: '#475569',
  },
  lavender: {
    id: 'lavender',
    name: 'Lavender',
    bg: '#f8effc',
    cardBg: '#f8effc',
    border: '#e8c9f8',
    text: '#581c87',
    secondaryText: '#6b21a8',
    badgeBg: '#f0d9fa',
    accent: '#a855f7',
  },
};

export type NoteItem = {
  id: string;
  path: string;
  title: string;
  content: string;
  isChecklist: boolean;
  checklistItems: ChecklistItem[];
  pinned: boolean;
  color: NoteColorId;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  archived?: boolean;
};

export type ViewMode = 'grid' | 'list';
