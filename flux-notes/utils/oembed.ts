export type LinkMetadata = {
  url: string;
  type?: 'video' | 'photo' | 'rich' | 'link';
  title?: string;
  description?: string;
  image?: string;
  videoUrl?: string;
  provider?: string;
  width?: number;
  height?: number;
};

const metadataCache = new Map<string, LinkMetadata>();

function decodeHtmlEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => {
      try {
        return String.fromCharCode(parseInt(dec, 10));
      } catch {
        return _;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch {
        return _;
      }
    })
    .trim();
}

function resolveUrl(relativeOrAbsolute: string, baseUrl: string): string {
  const trimmed = relativeOrAbsolute.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) {
    const protocol = baseUrl.startsWith('http://') ? 'http:' : 'https:';
    return `${protocol}${trimmed}`;
  }
  try {
    const match = baseUrl.match(/^(https?:\/\/[^/]+)/i);
    const origin = match ? match[1] : baseUrl;
    if (trimmed.startsWith('/')) {
      return `${origin}${trimmed}`;
    }
    const path = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    return `${path}${trimmed}`;
  } catch {
    return trimmed;
  }
}

function getAttribute(tag: string, attributeName: string): string | null {
  // Matches attr="value", attr='value', or attr=value
  const regex = new RegExp(`\\b${attributeName}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i');
  const match = tag.match(regex);
  if (match) {
    return decodeHtmlEntities(match[1] ?? match[2] ?? '');
  }
  return null;
}

function extractMetaTags(html: string): Record<string, string> {
  const metaMap: Record<string, string> = {};
  const metaRegex = /<meta\s+[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const property = getAttribute(tag, 'property') || getAttribute(tag, 'name') || getAttribute(tag, 'itemprop');
    const content = getAttribute(tag, 'content');

    if (property && content) {
      metaMap[property.toLowerCase()] = content;
    }
  }

  return metaMap;
}

function extractOEmbedLink(html: string, baseUrl: string): string | null {
  const linkRegex = /<link\s+[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null) {
    const tag = match[0];
    const rel = getAttribute(tag, 'rel')?.toLowerCase() || '';
    const type = getAttribute(tag, 'type')?.toLowerCase() || '';
    const href = getAttribute(tag, 'href');

    if (rel.includes('alternate') && (type === 'application/json+oembed' || type === 'text/json+oembed') && href) {
      return resolveUrl(href, baseUrl);
    }
  }

  return null;
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (match && match[1]) {
    return decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''));
  }
  return null;
}

export function hostnameOf(url: string): string {
  const match = url.match(/^https?:\/\/([^/]+)/i);
  return match ? match[1].replace(/^www\./i, '') : url;
}

export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  if (metadataCache.has(url)) {
    return metadataCache.get(url)!;
  }

  const fallbackResult: LinkMetadata = {
    url,
    title: hostnameOf(url),
    provider: hostnameOf(url),
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timer);

    if (!response.ok) {
      metadataCache.set(url, fallbackResult);
      return fallbackResult;
    }

    const html = await response.text();

    // 1. Tier 1: Look for oEmbed link on the page
    const oembedUrl = extractOEmbedLink(html, url);
    if (oembedUrl) {
      try {
        const oembedController = new AbortController();
        const oembedTimer = setTimeout(() => oembedController.abort(), 5000);

        const oembedRes = await fetch(oembedUrl, {
          signal: oembedController.signal,
          headers: { Accept: 'application/json' },
        });
        clearTimeout(oembedTimer);

        if (oembedRes.ok) {
          const oembedData = await oembedRes.json();
          if (oembedData && (oembedData.title || oembedData.thumbnail_url || oembedData.url || oembedData.html)) {
            const oembedType = oembedData.type; // 'photo' | 'video' | 'link' | 'rich'
            let photoUrl: string | undefined;
            if (oembedType === 'photo' && oembedData.url) {
              photoUrl = oembedData.url;
            } else {
              photoUrl = oembedData.thumbnail_url || undefined;
            }

            // Extract direct video URL if available or video stream in url/html
            let videoSrc: string | undefined;
            if (oembedType === 'video') {
              if (oembedData.html) {
                const srcMatch = oembedData.html.match(/src=["']([^"']+)["']/i);
                if (srcMatch) {
                  videoSrc = resolveUrl(srcMatch[1], url);
                }
              }
              if (!videoSrc && oembedData.url && /\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(oembedData.url)) {
                videoSrc = oembedData.url;
              }
            }

            const result: LinkMetadata = {
              url,
              type: oembedType,
              title: oembedData.title || undefined,
              description: oembedData.description || undefined,
              image: photoUrl,
              videoUrl: videoSrc,
              provider: oembedData.provider_name || oembedData.author_name || hostnameOf(url),
              width: typeof oembedData.width === 'number' ? oembedData.width : undefined,
              height: typeof oembedData.height === 'number' ? oembedData.height : undefined,
            };
            metadataCache.set(url, result);
            return result;
          }
        }
      } catch {
        // Continue to fallback if oEmbed endpoint fetch fails
      }
    }

    // 2. Tier 2: OpenGraph / Twitter Cards
    const meta = extractMetaTags(html);

    const ogType = meta['og:type'];
    const ogTitle = meta['og:title'] || meta['twitter:title'];
    const ogDescription = meta['og:description'] || meta['twitter:description'] || meta['description'];
    const rawImage =
      meta['og:image'] ||
      meta['og:image:url'] ||
      meta['og:image:secure_url'] ||
      meta['twitter:image'] ||
      meta['twitter:image:src'];
    const ogImage = rawImage ? resolveUrl(rawImage, url) : undefined;
    const rawVideo = meta['og:video'] || meta['og:video:url'] || meta['og:video:secure_url'];
    const ogVideo = rawVideo ? resolveUrl(rawVideo, url) : undefined;
    const ogProvider = meta['og:site_name'] || meta['twitter:site'] || hostnameOf(url);

    if (ogTitle || ogImage || ogDescription || ogVideo) {
      const isVideo = ogType?.includes('video') || Boolean(ogVideo);
      const isPhoto = ogType?.includes('image') || (Boolean(ogImage) && !ogDescription && !ogTitle);
      const result: LinkMetadata = {
        url,
        type: isVideo ? 'video' : isPhoto ? 'photo' : 'link',
        title: ogTitle || extractHtmlTitle(html) || hostnameOf(url),
        description: ogDescription,
        image: ogImage,
        videoUrl: ogVideo,
        provider: ogProvider,
      };
      metadataCache.set(url, result);
      return result;
    }

    // 3. Tier 3: HTML Title and standard description
    const htmlTitle = extractHtmlTitle(html);
    const htmlDesc = meta['description'];

    const result: LinkMetadata = {
      url,
      title: htmlTitle || hostnameOf(url),
      description: htmlDesc,
      provider: hostnameOf(url),
    };

    metadataCache.set(url, result);
    return result;
  } catch (error) {
    metadataCache.set(url, fallbackResult);
    return fallbackResult;
  }
}
