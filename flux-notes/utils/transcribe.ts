import { FLUX_CLOUD_URL } from '@flux-sdk/core';

// Converts a local recording URI to base64 and posts it to the cloud transcription
// endpoint. Fully on-device speech-to-text isn't available in Expo without a
// custom dev client, so transcription runs server-side (Whisper) when configured.
export async function transcribeAudio(uri: string, mimeType: string, token: string, instanceId: string): Promise<string | null> {
  try {
    const blob = await (await fetch(uri)).blob();
    const audioBase64 = await blobToBase64(blob);
    const response = await fetch(`${FLUX_CLOUD_URL}/api/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-instance-id': instanceId,
      },
      body: JSON.stringify({ audioBase64, mimeType, filename: 'recording.m4a' }),
    });
    if (!response.ok) return null;
    const json = await response.json();
    return typeof json?.data?.transcript === 'string' ? json.data.transcript : null;
  } catch {
    return null;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
