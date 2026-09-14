export type SpeechSession = {
  result: Promise<string>;
  stop: () => Promise<string>;
};

export async function startSpeechSession(): Promise<SpeechSession> {
  throw new Error('On-device speech recognition is unavailable on web');
}

export async function destroySpeechSession(): Promise<void> {}