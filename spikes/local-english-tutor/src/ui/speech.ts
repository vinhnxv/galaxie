// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Text-to-speech with English voices installed on this device. Voices whose `localService` is
// false may synthesize on a remote server, so the page never uses them.

import { useSyncExternalStore } from 'react';

function englishVoice(): SpeechSynthesisVoice | undefined {
  const local = speechSynthesis
    .getVoices()
    .filter((voice) => voice.localService && voice.lang.toLowerCase().startsWith('en'));
  return local.find((voice) => voice.lang === 'en-US') ?? local[0];
}

export function speak(text: string): void {
  const voice = englishVoice();
  if (voice === undefined) {
    return;
  }
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  utterance.rate = 0.9;
  speechSynthesis.speak(utterance);
}

const subscribe = (listener: () => void): (() => void) => {
  speechSynthesis.addEventListener('voiceschanged', listener);
  return () => speechSynthesis.removeEventListener('voiceschanged', listener);
};

/** Whether a local English voice is available. Browsers list voices asynchronously. */
export function useLocalEnglishVoice(): boolean {
  return useSyncExternalStore(subscribe, () => englishVoice() !== undefined);
}
