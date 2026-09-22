import { AttachmentBlock, ChecklistItem, NoteAttachment, NoteBlock, NoteColorId, NoteItem, TextBlock } from '../types/note';

export function ensureTextBlockBetweenAttachments(blocks: NoteBlock[]): NoteBlock[] {
  const normalized: NoteBlock[] = [];

  for (const block of blocks) {
    const previous = normalized[normalized.length - 1];
    if (previous?.type === 'attachment' && block.type === 'attachment') {
      normalized.push({
        id: `block_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        type: 'text',
        text: '',
        variant: 'paragraph',
      });
    }
    normalized.push(block);
  }

  return normalized;
}

export function parseBlocksFromMarkdown(rawBody: string, fallbackAttachments?: NoteAttachment[]): NoteBlock[] {
  const trimmed = (rawBody || '').trim();
  if (!trimmed) {
    if (fallbackAttachments && fallbackAttachments.length > 0) {
      return ensureTextBlockBetweenAttachments(fallbackAttachments.map((a) => attachmentToBlock(a)));
    }
    return [{ id: `block_${Date.now()}_0`, type: 'text', text: '', variant: 'paragraph' }];
  }

  const blocks: NoteBlock[] = [];
  const blockRegex = /([\s\S]*?)(?:\n|$)/g;

  let match: RegExpExecArray | null;
  let hasBlockComments = false;

  while ((match = blockRegex.exec(trimmed)) !== null) {
    hasBlockComments = true;
    const kind = match[1];
    let meta: any = {};
    try {
      meta = JSON.parse(match[2]);
    } catch {
      meta = {};
    }
    const body = (match[3] || '').trim();
    const id = meta.id || `block_${Date.now()}_${blocks.length}`;

    if (kind === 'text') {
      const isChecklist = Boolean(meta.isChecklist);
      let text = body;
      let checklistItems: ChecklistItem[] = [];

      if (isChecklist) {
        checklistItems = parseChecklistItems(body);
        text = checklistItems.map((item) => item.text).join('\n');
      } else {
        // Strip markdown heading marker if text already includes it
        if (meta.variant === 'h1' && text.startsWith('# ')) {
          text = text.slice(2);
        } else if (meta.variant === 'h2' && text.startsWith('## ')) {
          text = text.slice(3);
        }
      }

      blocks.push({
        id,
        type: 'text',
        text,
        variant: meta.variant || 'paragraph',
        bold: Boolean(meta.bold),
        italic: Boolean(meta.italic),
        underline: Boolean(meta.underline),
        strikethrough: Boolean(meta.strikethrough),
        isChecklist,
        checklistItems: isChecklist ? checklistItems : undefined,
      });
    } else if (kind === 'attachment') {
      blocks.push({
        id,
        type: 'attachment',
        attachmentType: meta.attachmentType || 'file',
        name: meta.name || 'Attachment',
        uri: meta.uri || '',
        mimeType: meta.mimeType,
        waveform: meta.waveform,
        durationMs: meta.durationMs,
        transcript: meta.transcript,
        transcriptStatus: meta.transcriptStatus,
      });
    }
  }

  if (hasBlockComments && blocks.length > 0) {
    return ensureTextBlockBetweenAttachments(blocks);
  }

  // Fallback: parse plain markdown into blocks
  const lines = trimmed.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // Check for checklist items
    if (/^\s*[-*]\s*\[([ xX])\]/.test(line)) {
      const checkItems: ChecklistItem[] = [];
      while (i < lines.length && /^\s*[-*]\s*\[([ xX])\]/.test(lines[i])) {
        const m = lines[i].match(/^\s*[-*]\s*\[([ xX])\]\s*(.*)$/);
        if (m) {
          checkItems.push({
            id: `item_${Date.now()}_${checkItems.length}`,
            completed: m[1].toLowerCase() === 'x',
            text: m[2].trim(),
          });
        }
        i++;
      }
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'text',
        text: checkItems.map((item) => item.text).join('\n'),
        variant: 'paragraph',
        isChecklist: true,
        checklistItems: checkItems,
      });
      continue;
    }

    // Check for image attachment: ![caption](uri)
    const imgMatch = line.match(/^!\[([^\]]*)\]\((.+)\)$/);
    if (imgMatch) {
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'attachment',
        attachmentType: 'image',
        name: imgMatch[1] || 'Image',
        uri: imgMatch[2],
        mimeType: 'image/jpeg',
      });
      i++;
      continue;
    }

    // Check for bare web link
    if (/^https?:\/\/\S+$/.test(line.trim())) {
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'attachment',
        attachmentType: 'link',
        name: line.trim(),
        uri: line.trim(),
      });
      i++;
      continue;
    }

    // Check for markdown link: [name](uri)
    const linkMatch = line.match(/^\[([^\]]+)\]\((.+)\)$/);
    if (linkMatch) {
      const name = linkMatch[1];
      const uri = linkMatch[2];
      const kind = inferAttachmentKind(name, uri);
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'attachment',
        attachmentType: kind,
        name,
        uri,
      });
      i++;
      continue;
    }

    // Heading 1
    if (line.startsWith('# ')) {
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'text',
        text: line.slice(2).trim(),
        variant: 'h1',
      });
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith('## ')) {
      blocks.push({
        id: `block_${Date.now()}_${blocks.length}`,
        type: 'text',
        text: line.slice(3).trim(),
        variant: 'h2',
      });
      i++;
      continue;
    }

    // Standard paragraph or bullet line
    blocks.push({
      id: `block_${Date.now()}_${blocks.length}`,
      type: 'text',
      text: line,
      variant: 'paragraph',
    });
    i++;
  }

  // If there were any fallbackAttachments not represented in blocks, add them
  if (fallbackAttachments && fallbackAttachments.length > 0) {
    for (const att of fallbackAttachments) {
      const exists = blocks.some((b) => b.type === 'attachment' && b.uri === att.uri);
      if (!exists) {
        blocks.push(attachmentToBlock(att));
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ id: `block_${Date.now()}_0`, type: 'text', text: '', variant: 'paragraph' });
  }

  return ensureTextBlockBetweenAttachments(blocks);
}

function inferAttachmentKind(name: string, uri: string): 'image' | 'video' | 'audio' | 'file' | 'link' {
  const lower = (name + ' ' + uri).toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|bmp)(\?.*)?$/i.test(lower)) return 'image';
  if (/\.(mp4|mov|webm|mkv|m4v)(\?.*)?$/i.test(lower)) return 'video';
  if (/\.(m4a|mp3|wav|aac|ogg|flac)(\?.*)?$/i.test(lower)) return 'audio';
  if (/^https?:\/\//i.test(uri)) return 'link';
  return 'file';
}

function attachmentToBlock(att: NoteAttachment): AttachmentBlock {
  return {
    id: att.id || `block_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    type: 'attachment',
    attachmentType: att.kind === 'drawing' ? 'image' : att.kind,
    name: att.name,
    uri: att.uri,
    mimeType: att.mimeType,
    waveform: att.waveform,
    durationMs: att.durationMs,
    transcript: att.transcript,
    transcriptStatus: att.transcriptStatus,
  };
}

export function serializeBlocksToMarkdown(blocks: NoteBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') {
        const meta = {
          id: block.id,
          variant: block.variant,
          bold: block.bold || false,
          italic: block.italic || false,
          underline: block.underline || false,
          strikethrough: block.strikethrough || false,
          isChecklist: block.isChecklist || false,
        };
        let body = block.text || '';
        if (block.isChecklist && block.checklistItems && block.checklistItems.length > 0) {
          body = block.checklistItems
            .map((item) => `- [${item.completed ? 'x' : ' '}] ${item.text}`)
            .join('\n');
        } else if (block.variant === 'h1') {
          body = `# ${body}`;
        } else if (block.variant === 'h2') {
          body = `## ${body}`;
        }
        return body;
      } else if (block.type === 'attachment') {
        const meta = {
          id: block.id,
          attachmentType: block.attachmentType,
          name: block.name,
          uri: block.uri,
          mimeType: block.mimeType,
          waveform: block.waveform,
          durationMs: block.durationMs,
          transcript: block.transcript,
          transcriptStatus: block.transcriptStatus,
        };
        let body = '';
        if (block.attachmentType === 'image') {
          body = `![${block.name}](${block.uri})`;
        } else if (block.attachmentType === 'link') {
          body = block.uri;
        } else {
          body = `[${block.name}](${block.uri})`;
        }
        return body;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export function extractAttachmentsFromBlocks(blocks: NoteBlock[]): NoteAttachment[] {
  const attachments: NoteAttachment[] = [];
  for (const block of blocks) {
    if (block.type === 'attachment') {
      attachments.push({
        id: block.id,
        name: block.name,
        uri: block.uri,
        mimeType: block.mimeType || 'application/octet-stream',
        kind: block.attachmentType === 'link' ? 'link' : block.attachmentType,
        waveform: block.waveform,
        durationMs: block.durationMs,
        transcript: block.transcript,
        transcriptStatus: block.transcriptStatus,
      });
    }
  }
  return attachments;
}

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
      } else if (!firstLine.startsWith('- [') && !firstLine.startsWith('<!--')) {
        title = firstLine;
      }
    }
  }

  const pinned = parseBoolean(metaMap.pinned);
  const archived = parseBoolean(metaMap.archived);
  const color = (metaMap.color || 'default') as NoteColorId;
  const isChecklist = parseBoolean(metaMap.isChecklist);

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
    content: removeDuplicatedTitleHeading(bodyText, title),
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

function parseBoolean(value?: string): boolean {
  return value?.trim().replace(/^['"]|['"]$/g, '').toLowerCase() === 'true';
}

function removeDuplicatedTitleHeading(body: string, title: string): string {
  const lines = body.split('\n');
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstContentIndex === -1) return body;

  const firstLine = lines[firstContentIndex].trim();
  if (firstLine === `# ${title}`) {
    lines.splice(firstContentIndex, 1);
    if (lines[firstContentIndex] === '') lines.splice(firstContentIndex, 1);
  }
  return lines.join('\n').trim();
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
    `attachments: ${JSON.stringify(note.attachments || [])}`,
    `createdAt: ${createdAt}`,
    `updatedAt: ${updatedAt}`,
  ];

  if (archived) {
    frontmatterObj.push(`archived: true`);
  }

  const frontmatterStr = `---\n${frontmatterObj.join('\n')}\n---`;

  // The title belongs in frontmatter and is rendered by the app. Keeping a
  // second H1 in the body duplicates it in cards and the editor.
  return `${frontmatterStr}\n\n${body}`.trim();
}
