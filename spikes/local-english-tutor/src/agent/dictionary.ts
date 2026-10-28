// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// A tool for the lesson pipeline: pronunciations from the CMU Pronouncing Dictionary, converted to
// IPA. The pipeline hands them to the model, which reviews them against the sentence and writes the
// transcription the page shows. The IPA is US English in learner-dictionary style (/friːz/,
// /bɪˈfɔːr/), with the primary stress marked on words of two or more syllables.

type Entries = Readonly<Record<string, string>>;

export interface DictionaryEntry {
  readonly word: string;
  /** Each IPA transcription the dictionary lists for the word; empty if it lacks the word. */
  readonly ipa: readonly string[];
}

let entries: Promise<Entries> | undefined;

/** The dictionary is a 4.7 MB module, so it loads on first use. */
function loadEntries(): Promise<Entries> {
  entries ??= import('cmu-pronouncing-dictionary').then((module) => module.dictionary);
  return entries;
}

export async function lookUp(words: readonly string[]): Promise<DictionaryEntry[]> {
  const all = await loadEntries();
  return words.map((word) => ({ word, ipa: [...new Set(variants(word, all).map(toIpa))] }));
}

/** Makes two transcriptions comparable: no slashes, spaces, syllable dots or secondary stress. */
export function normalizeIpa(ipa: string): string {
  return ipa
    .replace(/[/[\]\s.ˌ]/g, '')
    .replaceAll('g', 'ɡ')
    .replaceAll('ɹ', 'r')
    .replaceAll(':', 'ː');
}

/** How the model's transcription of a word relates to what the dictionary lists for it. */
export type DictionaryMatch = 'kept' | 'changed' | 'not-in-dictionary';

export function compareWithDictionary(ipa: string, entry: DictionaryEntry): DictionaryMatch {
  if (entry.ipa.length === 0) {
    return 'not-in-dictionary';
  }
  const own = normalizeIpa(ipa);
  return entry.ipa.some((form) => normalizeIpa(form) === own) ? 'kept' : 'changed';
}

// Alternate pronunciations are stored as "read(2)", "read(3)" and so on.
function variants(word: string, all: Entries): string[] {
  const key = word.toLowerCase().replaceAll('’', "'");
  const found: string[] = [];
  for (let n = 1; ; n++) {
    const arpabet = all[n === 1 ? key : `${key}(${n})`];
    if (arpabet === undefined) {
      break;
    }
    found.push(arpabet);
  }
  if (found.length === 0 && key.includes('-')) {
    const parts = key.split('-').map((part) => all[part]);
    if (parts.every((part) => part !== undefined)) {
      found.push(parts.join(' '));
    }
  }
  return found;
}

interface Phone {
  readonly ipa: string;
  readonly vowel: boolean;
  /** 0, 1 or 2 for vowels; -1 for consonants. */
  readonly stress: number;
}

const VOWELS: Readonly<Record<string, readonly [stressed: string, unstressed: string]>> = {
  AA: ['ɑː', 'ɑ'],
  AE: ['æ', 'æ'],
  AH: ['ʌ', 'ə'],
  AO: ['ɔː', 'ɔ'],
  AW: ['aʊ', 'aʊ'],
  AY: ['aɪ', 'aɪ'],
  EH: ['e', 'e'],
  ER: ['ɝː', 'ɚ'],
  EY: ['eɪ', 'eɪ'],
  IH: ['ɪ', 'ɪ'],
  IY: ['iː', 'i'],
  OW: ['oʊ', 'oʊ'],
  OY: ['ɔɪ', 'ɔɪ'],
  UH: ['ʊ', 'ʊ'],
  UW: ['uː', 'u'],
};

const CONSONANTS: Readonly<Record<string, string>> = {
  B: 'b',
  CH: 'tʃ',
  D: 'd',
  DH: 'ð',
  F: 'f',
  G: 'ɡ',
  HH: 'h',
  JH: 'dʒ',
  K: 'k',
  L: 'l',
  M: 'm',
  N: 'n',
  NG: 'ŋ',
  P: 'p',
  R: 'r',
  S: 's',
  SH: 'ʃ',
  T: 't',
  TH: 'θ',
  V: 'v',
  W: 'w',
  Y: 'j',
  Z: 'z',
  ZH: 'ʒ',
};

// Consonant sequences that can start an English syllable. The stress mark goes before the longest
// one that ends right before the stressed vowel (the maximal-onset rule).
const ONSETS = new Set(
  (
    'p b t d k ɡ f v θ ð s z ʃ ʒ h tʃ dʒ m n l r w j ' +
    'pl pr pj bl br bj tr tw dr dw kl kr kw kj ɡl ɡr ɡw fl fr fj vj θr θw ʃr ' +
    'sp st sk sm sn sl sw sf spl spr spj str skr skw skj mj nj hj lj'
  ).split(' '),
);

function toPhones(arpabet: string): Phone[] {
  return arpabet.split(' ').map((symbol) => {
    const match = /^([A-Z]+)([012])?$/.exec(symbol);
    const base = match?.[1] ?? symbol;
    const vowel = VOWELS[base];
    if (vowel !== undefined) {
      const stress = Number(match?.[2] ?? 0);
      return { ipa: stress > 0 ? vowel[0] : vowel[1], vowel: true, stress };
    }
    const consonant = CONSONANTS[base];
    if (consonant === undefined) {
      throw new Error(`unknown ARPAbet symbol ${symbol}`);
    }
    return { ipa: consonant, vowel: false, stress: -1 };
  });
}

/** Where the syllable of the vowel at `vowelIndex` starts, by the maximal-onset rule. */
function syllableStart(phones: readonly Phone[], vowelIndex: number): number {
  let previousVowel = vowelIndex - 1;
  while (previousVowel >= 0 && !phones[previousVowel]?.vowel) {
    previousVowel--;
  }
  if (previousVowel < 0) {
    return 0;
  }
  for (let start = previousVowel + 1; start < vowelIndex; start++) {
    const onset = phones
      .slice(start, vowelIndex)
      .map((phone) => phone.ipa)
      .join('');
    if (ONSETS.has(onset)) {
      return start;
    }
  }
  return vowelIndex;
}

function toIpa(arpabet: string): string {
  const phones = toPhones(arpabet);
  const vowels = phones.filter((phone) => phone.vowel).length;
  const stressed = phones.findIndex((phone) => phone.stress === 1);
  const markAt = vowels > 1 && stressed >= 0 ? syllableStart(phones, stressed) : -1;
  return phones.map((phone, i) => (i === markAt ? `ˈ${phone.ipa}` : phone.ipa)).join('');
}
