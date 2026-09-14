import { FLUX_CLOUD_URL } from '@flux-sdk/core';

export type OEmbedData = {
  url: string;
  title?: string;
  providerName?: string;
  authorName?: string;
  thumbnailUrl?: string;
  html?: string;
};

const URL_PATTERN = /https?:\/\/[^\s)]+/i;

export function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN);
  return match ? match[0].replace(/[.,;)]+$/, '') : null;
}

// Providers whose oEmbed endpoints are public and CORS-friendly enough to call
// directly from the device. React Native has no browser CORS restriction, so
// this works out of the box on iOS/Android; only the web build needs the proxy.
const DIRECT_PROVIDERS: Array<{ test: RegExp; endpoint: (url: string) => string }> = [
  { test: /(^|\.)youtube\.com|youtu\.be/i, endpoint: (u) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  { test: /vimeo\.com/i, endpoint: (u) => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(u)}` },
  { test: /soundcloud\.com/i, endpoint: (u) => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u)}` },
  { test: /open\.spotify\.com/i, endpoint: (u) => `https://open.spotify.com/oembed?url=${encodeURIComponent(u)}` },
  { test: /codepen\.io/i, endpoint: (u) => `https://codepen.io/api/oembed?format=json&url=${encodeURIComponent(u)}` },
  { test: /flickr\.com/i, endpoint: (u) => `https://www.flickr.com/services/oembed?format=json&url=${encodeURIComponent(u)}` },
];

const cache = new Map<string, Promise<OEmbedData | null>>();

async function tryFetchJson(endpoint: string): Promise<OEmbedData | null> {
  const response = await fetch(endpoint);
  if (!response.ok) return null;
  const json = await response.json();
  return normalize(json);
}

function normalize(json: Record<string, unknown>): OEmbedData | null {
  if (!json || typeof json !== 'object') return null;
  return {
    url: String(json.url || ''),
    title: typeof json.title === 'string' ? json.title : undefined,
    providerName: typeof json.provider_name === 'string' ? json.provider_name : undefined,
    authorName: typeof json.author_name === 'string' ? json.author_name : undefined,
    thumbnailUrl: typeof json.thumbnail_url === 'string' ? json.thumbnail_url : undefined,
    html: typeof json.html === 'string' ? json.html : undefined,
  };
}

export function fetchOEmbed(url: string): Promise<OEmbedData | null> {
  const cached = cache.get(url);
  if (cached) return cached;

  const promise = (async () => {
    const provider = DIRECT_PROVIDERS.find((p) => p.test.test(url));
    if (provider) {
      try {
        const data = await tryFetchJson(provider.endpoint(url));
        if (data) return { ...data, url };
      } catch {
        // fall through to the cloud proxy below
      }
    }

    try {
      const data = await tryFetchJson(`${FLUX_CLOUD_URL}/api/oembed?url=${encodeURIComponent(url)}`);
      if (data) return { ...data, url };
    } catch {
      // no embed available; render as a plain link
    }
    return null;
  })();

  cache.set(url, promise);
  return promise;
}
