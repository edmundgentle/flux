import VoiceToText, { VoiceToTextEvents } from '@appcitor/react-native-voice-to-text';

export type SpeechSession = {
  result: Promise<string>;
  stop: () => Promise<string>;
};

export async function startSpeechSession(): Promise<SpeechSession> {
  const available = await VoiceToText.isRecognitionAvailable();
  if (!available) throw new Error('Speech recognition is unavailable on this device');

  let latestResult = '';
  const resultSubscription = VoiceToText.addEventListener(VoiceToTextEvents.RESULTS, (event) => {
    latestResult = event.value;
  });
  const result = VoiceToText.startListening({ continuous: true })
    .then((value) => value || latestResult)
    .finally(() => resultSubscription.remove());

  return {
    result,
    stop: async () => {
      const value = await VoiceToText.stopListening();
      return value || latestResult || await result;
    },
  };
}

export async function destroySpeechSession(): Promise<void> {
  await VoiceToText.destroy();
}