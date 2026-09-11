import { ChecklistItem, NoteColorId, NoteItem } from '../types/note';

export function parseNoteMarkdown(rawContent: string, filePath: string, fileDateCreated?: number): NoteItem {
  let frontmatterText = '';
  let bodyText = rawContent;

  if (rawContent.startsWith('---')) {
    const endMatchIndex = rawContent.indexOf('\n---', 3);
    if (endMatchIndex !== -1) {
      frontmatterText = rawContent.substring(3, endMatchIndex).trim();
      bodyText = rawContent.substring(endMatchIndex + 4).trim();
    }
  }

  // Parse YAML-like lines
  const metaMap: Record<string, string> = {};
  if (frontmatterText) {
    const lines = frontmatterText.split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        metaMap[key] = value;
      }
    }
  }

  // Extract ID from path if not present in frontmatter
  const filename = filePath.split('/').pop() || '';
  const fallbackId = filename.replace(/\.md$/, '') || `note_${Date.now()}`;
  const id = metaMap.id || fallbackId;

  // Title: frontmatter title or first header or first line
  let title = metaMap.title || '';
  if (title.startsWith('"') && title.endsWith('"')) {
    title = title.substring(1, title.length - 1);
  }

  if (!title) {
    const lines = bodyText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      const firstLine = lines[0];
      if (firstLine.startsWith('#')) {
        title = firstLine.replace(/^#+\s*/, '');
      } else if (!firstLine.startsWith('- [')) {
        title = firstLine;
      }
    }
  }

  const pinned = metaMap.pinned === 'true';
  const archived = metaMap.archived === 'true';
  const color = (metaMap.color || 'default') as NoteColorId;
  const isChecklist = metaMap.isChecklist === 'true' || checkHasChecklistItems(bodyText);

  let labels: string[] = [];
  if (metaMap.labels) {
    try {
      const parsed = JSON.parse(metaMap.labels);
      if (Array.isArray(parsed)) {
        labels = parsed.map(String);
      }
    } catch {
      labels = metaMap.labels.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  const now = Date.now();
  const fallbackTime = fileDateCreated ? fileDateCreated * 1000 : now;
  const createdAt = metaMap.createdAt ? Number(metaMap.createdAt) || fallbackTime : fallbackTime;
  const updatedAt = metaMap.updatedAt ? Number(metaMap.updatedAt) || fallbackTime : fallbackTime;

  // Parse checklist items if applicable
  const checklistItems = parseChecklistItems(bodyText);

  return {
    id,
    path: filePath,
    title: title || 'Untitled Note',
    content: bodyText,
    isChecklist,
    checklistItems,
    pinned,
    color,
    labels,
    createdAt,
    updatedAt,
    archived,
  };
}

function checkHasChecklistItems(text: string): boolean {
  const lineRegex = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/m;
  return lineRegex.test(text);
}

export function parseChecklistItems(text: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = text.split('\n');
  let idx = 0;
  for (const line of lines) {
    const match = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
    if (match) {
      const completed = match[1].toLowerCase() === 'x';
      const itemText = match[2].trim();
      items.push({
        id: `item_${idx}_${Date.now()}`,
        text: itemText,
        completed,
      });
      idx++;
    }
  }
  return items;
}

export function serializeNoteMarkdown(note: Partial<NoteItem> & { title: string }): string {
  const now = Date.now();
  const id = note.id || `note_${now}_${Math.random().toString(36).substring(2, 7)}`;
  const pinned = note.pinned ?? false;
  const archived = note.archived ?? false;
  const color = note.color || 'default';
  const isChecklist = note.isChecklist ?? false;
  const labels = note.labels || [];
  const createdAt = note.createdAt || now;
  const updatedAt = now;

  let body = note.content || '';

  if (isChecklist && note.checklistItems && note.checklistItems.length > 0) {
    const checklistMarkdown = note.checklistItems
      .map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`)
      .join('\n');
    
    // If there's a non-checklist text body, preserve it before checklist
    const nonChecklistBody = body
      .split('\n')
      .filter((line) => !line.match(/^\s*[-*]\s*\[([ xX])\]/))
      .join('\n')
      .trim();

    body = nonChecklistBody ? `${nonChecklistBody}\n\n${checklistMarkdown}` : checklistMarkdown;
  }

  const frontmatterObj = [
    `id: ${id}`,
    `title: ${JSON.stringify(note.title)}`,
    `pinned: ${pinned}`,
    `color: ${color}`,
    `isChecklist: ${isChecklist}`,
    `labels: ${JSON.stringify(labels)}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
  ];

  if (archived) {
    frontmatterObj.push(`archived: true`);
  }

  const frontmatterStr = `---\n${frontmatterObj.join('\n')}\n---`;

  let titleHeader = '';
  if (note.title && !body.startsWith('# ')) {
    titleHeader = `# ${note.title}\n\n`;
  }

  return `${frontmatterStr}\n\n${titleHeader}${body}`.trim();
}
