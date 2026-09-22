import Constants from 'expo-constants';

export type SpeechSession = {
  result: Promise<string>;
  stop: () => Promise<string>;
};

function isExpoGo(): boolean {
  return Constants.appOwnership === 'expo'
    || String(Constants.executionEnvironment).toLowerCase() === 'storeclient';
}

export async function startSpeechSession(): Promise<SpeechSession> {
  if (isExpoGo()) {
    return { result: Promise.resolve(''), stop: async () => '' };
  }

  const { default: VoiceToText, VoiceToTextEvents } = await import('@appcitor/react-native-voice-to-text');
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
  if (isExpoGo()) return;
  const { default: VoiceToText } = await import('@appcitor/react-native-voice-to-text');
  await VoiceToText.destroy();
}