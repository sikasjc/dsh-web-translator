/** Dictionary trimming and silent-degradation lookup (DESIGN §5.7). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeLogger } from './helpers.mjs';
import {
  DICTIONARY_ENDPOINT,
  WIKTIONARY_ENDPOINT,
  WIKTIONARY_USER_AGENT,
  createDictionaryLookup,
  isEnglishWord,
  sanitizeDictionary,
  trimDictionary,
  trimWiktionary,
} from '../lib/dictionary.js';

/** dictionaryapi.dev-shaped fixture. */
const API_FIXTURE = [{
  word: 'immersive',
  phonetic: '/ɪˈmɜːsɪv/',
  phonetics: [
    { text: '/ɪˈmɜːsɪv/', audio: '' },
    { text: '', audio: 'https://api.dictionaryapi.dev/media/pronunciations/en/immersive.mp3' },
  ],
  meanings: [
    {
      partOfSpeech: 'adjective',
      definitions: [
        { definition: '  Giving   a feeling of being surrounded.  ', example: 'an immersive experience' },
        { definition: 'Deeply involving.' },
        { definition: 'Third definition.' },
        { definition: 'Fourth definition dropped by the cap.' },
      ],
    },
    { partOfSpeech: 'noun', definitions: [{ definition: 'An immersive thing.' }] },
  ],
}];

test('isEnglishWord accepts a single word only', () => {
  assert.equal(isEnglishWord('immersive'), true);
  assert.equal(isEnglishWord("don't"), true);
  assert.equal(isEnglishWord('well-known'), true);
  assert.equal(isEnglishWord('  hello  '), true);
  assert.equal(isEnglishWord('hello world'), false);
  assert.equal(isEnglishWord('123'), false);
  assert.equal(isEnglishWord(''), false);
  assert.equal(isEnglishWord('x'.repeat(42)), false);
  assert.equal(isEnglishWord(null), false);
});

test('trimDictionary keeps word/phonetic/audio/meanings within the caps', async () => {
  const dictionary = trimDictionary(API_FIXTURE);
  assert.equal(dictionary.word, 'immersive');
  assert.equal(dictionary.phonetic, '/ɪˈmɜːsɪv/');
  assert.equal(dictionary.audio, 'https://api.dictionaryapi.dev/media/pronunciations/en/immersive.mp3');
  assert.equal(dictionary.meanings.length, 2);
  assert.equal(dictionary.meanings[0].partOfSpeech, 'adjective');
  assert.deepEqual(dictionary.meanings[0].definitions, [
    'Giving a feeling of being surrounded.',
    'Deeply involving.',
    'Third definition.',
  ]);
  assert.equal(dictionary.meanings[1].definitions.length, 1);
});

test('trimDictionary rejects unusable payloads', () => {
  assert.equal(trimDictionary(undefined), undefined);
  assert.equal(trimDictionary([]), undefined);
  assert.equal(trimDictionary([{}]), undefined);
  assert.equal(trimDictionary([{ meanings: [] }]), undefined);
  assert.equal(trimDictionary([{ meanings: [{ definitions: [] }] }]), undefined);
});

test('sanitizeDictionary caps extension-supplied dictionaries and http(s) audio only', () => {
  const clean = sanitizeDictionary({
    word: 'immersive',
    audio: 'https://cdn.example.com/a.mp3',
    meanings: Array.from({ length: 6 }, (_, meaningIndex) => ({
      partOfSpeech: `pos-${meaningIndex}`,
      definitions: Array.from({ length: 5 }, (_, index) => `definition ${meaningIndex}-${index}`),
    })),
  });
  assert.equal(clean.meanings.length, 4);
  assert.equal(clean.meanings[0].definitions.length, 3);
  assert.equal(sanitizeDictionary({ audio: 'javascript:alert(1)', meanings: [{ definitions: ['x'] }] }).audio, undefined);
  assert.equal(sanitizeDictionary('nope'), undefined);
  assert.equal(sanitizeDictionary(null), undefined);
});

test('lookupWord queries dictionaryapi.dev for a word and returns the trimmed result', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => API_FIXTURE };
  };
  const lookup = createDictionaryLookup({ fetchImpl });
  const dictionary = await lookup.lookupWord('Immersive');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${DICTIONARY_ENDPOINT}immersive`);
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.equal(dictionary.word, 'immersive');
});

test('lookupWord degrades silently for non-words, failures and exceptions', async () => {
  let calls = 0;
  const recordingFetch = async () => {
    calls += 1;
    return { ok: true, json: async () => API_FIXTURE };
  };
  const lookup = createDictionaryLookup({ fetchImpl: recordingFetch, logger: createFakeLogger() });
  assert.equal(await lookup.lookupWord('hello world'), undefined);
  assert.equal(calls, 0, 'phrases never hit the network');

  const notFoundFetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  assert.equal(await createDictionaryLookup({ fetchImpl: notFoundFetch }).lookupWord('asdfgh'), undefined);

  const throwingFetch = async () => {
    throw new Error('network down');
  };
  assert.equal(await createDictionaryLookup({ fetchImpl: throwingFetch }).lookupWord('immersive'), undefined);
  assert.equal(await createDictionaryLookup({ fetchImpl: null }).lookupWord('immersive'), undefined);
});

/** en.wiktionary.org REST fixture with HTML fragments. */
const WIKTIONARY_FIXTURE = {
  en: [
    {
      partOfSpeech: 'Adjective',
      language: 'English',
      definitions: [
        { definition: 'Tending to <a rel="mw:WikiLink" href="/wiki/immerse">immerse</a>.' },
        { definition: 'Giving the impression of <a href="/wiki/immersion">immersion</a>.' },
        { definition: '<span class="x">Deeply</span> involving &amp; engaging.' },
        { definition: 'Fourth definition dropped by the cap.' },
      ],
    },
    { partOfSpeech: 'Noun', definitions: [{ definition: 'An &quot;immersive&quot; thing.' }] },
  ],
  fr: [{ partOfSpeech: 'Adjective', language: 'French', definitions: [{ definition: 'form-of definition' }] }],
};

test('trimWiktionary strips HTML and keeps en definitions within the caps', () => {
  assert.deepEqual(trimWiktionary(WIKTIONARY_FIXTURE), {
    meanings: [
      { partOfSpeech: 'adjective', definitions: ['Tending to immerse.', 'Giving the impression of immersion.', 'Deeply involving & engaging.'] },
      { partOfSpeech: 'noun', definitions: ['An "immersive" thing.'] },
    ],
  });
  assert.equal(trimWiktionary({ en: [] }), undefined);
  assert.equal(trimWiktionary({ fr: [{ definitions: [{ definition: 'x' }] }] }), undefined);
  assert.equal(trimWiktionary(null), undefined);
});

test('lookupWord queries the selected provider and applies Wiktionary normalization', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => WIKTIONARY_FIXTURE };
  };
  const lookup = createDictionaryLookup({ fetchImpl, resolveProvider: () => 'wiktionary' });
  const dictionary = await lookup.lookupWord('Immersive');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WIKTIONARY_ENDPOINT}immersive`);
  assert.equal(calls[0].options.headers.accept, 'application/json');
  assert.equal(calls[0].options.headers['user-agent'], WIKTIONARY_USER_AGENT);
  assert.equal(dictionary.meanings[0].definitions[0], 'Tending to immerse.');
  assert.equal(dictionary.phonetic, undefined);
  assert.equal(dictionary.audio, undefined);

  // Resolver is consulted per lookup, so a settings change applies immediately.
  let providerReads = 0;
  const dynamic = createDictionaryLookup({
    fetchImpl,
    resolveProvider: async () => (providerReads++ === 0 ? 'off' : 'dictionaryapi.dev'),
  });
  assert.equal(await dynamic.lookupWord('immersive'), undefined);
  assert.equal(calls.length, 1, 'off makes no request');
  assert.equal(await dynamic.lookupWord('immersive'), undefined, 'dictionaryapi fixture shape differs; degrades');
  assert.equal(calls.length, 2);
});

test('lookupWord treats off/unknown providers as no dictionary and survives a throwing resolver', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { ok: true, json: async () => API_FIXTURE };
  };
  assert.equal(await createDictionaryLookup({ fetchImpl, resolveProvider: () => 'off' }).lookupWord('immersive'), undefined);
  assert.equal(await createDictionaryLookup({ fetchImpl, resolveProvider: () => 'youdao' }).lookupWord('immersive'), undefined);
  assert.equal(calls, 0);

  const throwingResolver = () => {
    throw new Error('settings unavailable');
  };
  const lookup = createDictionaryLookup({ fetchImpl, resolveProvider: throwingResolver });
  const dictionary = await lookup.lookupWord('immersive');
  assert.equal(calls, 1, 'a broken resolver falls back to the default provider');
  assert.equal(dictionary.word, 'immersive');
});
