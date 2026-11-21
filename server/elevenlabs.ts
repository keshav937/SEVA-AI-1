export interface ElevenLabsVoiceOption {
  voice_id: string;
  name: string;
  category: string;
  labels?: Record<string, string>;
}

export type SupportedVoiceLanguage = 'en' | 'hi' | 'bn' | 'as';

export interface LanguageVoiceCapability {
  code: SupportedVoiceLanguage;
  label: string;
  nativeLabel: string;
  sttSupported: boolean;
  sttLanguageCode: string;
  ttsSupported: boolean;
  ttsModel: string;
  notes: string;
}

export const VOICE_LANGUAGE_CAPABILITIES: Record<SupportedVoiceLanguage, LanguageVoiceCapability> = {
  en: {
    code: 'en',
    label: 'English',
    nativeLabel: 'English',
    sttSupported: true,
    sttLanguageCode: 'eng',
    ttsSupported: true,
    ttsModel: 'eleven_multilingual_v2',
    notes: 'Full speech recognition and natural English voice synthesis.',
  },
  hi: {
    code: 'hi',
    label: 'Hindi',
    nativeLabel: 'हिन्दी',
    sttSupported: true,
    sttLanguageCode: 'hin',
    ttsSupported: true,
    ttsModel: 'eleven_multilingual_v2',
    notes: 'Full multilingual speech recognition and natural Hindi voice synthesis.',
  },
  bn: {
    code: 'bn',
    label: 'Bengali',
    nativeLabel: 'বাংলা',
    sttSupported: true,
    sttLanguageCode: 'ben',
    ttsSupported: true,
    ttsModel: 'eleven_multilingual_v2 / gemini-3.8-flash-lite-tts',
    notes:
      'Bengali speech-to-text supported via ElevenLabs Scribe & Gemini Transcribe; natural Bengali speech synthesized via Gemini Speech Engine when ElevenLabs multilingual_v2 skips Bengali script.',
  },
  as: {
    code: 'as',
    label: 'Assamese',
    nativeLabel: 'অসমীয়া',
    sttSupported: true,
    sttLanguageCode: 'asm',
    ttsSupported: true,
    ttsModel: 'eleven_multilingual_v2 / gemini-3.8-flash-lite-tts',
    notes:
      'Assamese speech-to-text supported via ElevenLabs Scribe & Gemini Transcribe; spoken summary synthesized via Gemini Speech Engine when ElevenLabs multilingual_v2 skips Assamese script.',
  },
};

export const DEFAULT_ELEVENLABS_VOICES: ElevenLabsVoiceOption[] = [
  {
    voice_id: '21m00Tcm4TlvDq8ikWAM',
    name: 'Rachel (Warm & Clear)',
    category: 'premade',
    labels: { accent: 'neutral', description: 'Warm, calm civic advisor' },
  },
  {
    voice_id: 'EXAVITQu4vr4xnSDxMaL',
    name: 'Sarah (Soft & Articulate)',
    category: 'premade',
    labels: { accent: 'neutral', description: 'Friendly, reassuring' },
  },
  {
    voice_id: 'pNInz6obpgDQGcFmaJgB',
    name: 'Adam (Clear & Steady)',
    category: 'premade',
    labels: { accent: 'neutral', description: 'Authoritative, steady' },
  },
  {
    voice_id: 'IKne3meq5aSn9XLyUdCD',
    name: 'Charlie (Conversational)',
    category: 'premade',
    labels: { accent: 'neutral', description: 'Approachable' },
  },
];

export function isElevenLabsConfigured(): boolean {
  const key = process.env.ELEVENLABS_API_KEY;
  return Boolean(key && key.trim().length > 8 && !key.startsWith('MY_'));
}

export async function listElevenLabsVoices(): Promise<{
  configured: boolean;
  voices: ElevenLabsVoiceOption[];
  error?: string;
}> {
  if (!isElevenLabsConfigured()) {
    return {
      configured: false,
      voices: DEFAULT_ELEVENLABS_VOICES,
      error: 'ELEVENLABS_API_KEY is not configured in server environment secrets.',
    };
  }

  try {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        configured: true,
        voices: DEFAULT_ELEVENLABS_VOICES,
        error: `ElevenLabs voices lookup failed (${res.status}): ${errText.slice(0, 160)}`,
      };
    }

    const data = (await res.json()) as { voices?: ElevenLabsVoiceOption[] };
    const voices = (data.voices || []).slice(0, 20).map((v) => ({
      voice_id: v.voice_id,
      name: v.name,
      category: v.category || 'library',
      labels: v.labels,
    }));

    return {
      configured: true,
      voices: voices.length > 0 ? voices : DEFAULT_ELEVENLABS_VOICES,
    };
  } catch (err: any) {
    return {
      configured: true,
      voices: DEFAULT_ELEVENLABS_VOICES,
      error: err?.message || 'Unable to reach ElevenLabs API.',
    };
  }
}

export async function synthesizeWithElevenLabs(params: {
  text: string;
  voiceId?: string;
  language?: SupportedVoiceLanguage;
}): Promise<Buffer> {
  if (!isElevenLabsConfigured()) {
    const err = new Error('ELEVENLABS_API_KEY is not configured on the server.');
    (err as any).code = 'ELEVENLABS_KEY_MISSING';
    throw err;
  }

  const lang = params.language || 'en';
  const capability = VOICE_LANGUAGE_CAPABILITIES[lang];
  if (lang === 'bn' || lang === 'as' || (capability && !capability.ttsSupported)) {
    const err = new Error(capability?.notes || 'Language handled via Gemini Speech Engine.');
    (err as any).code = 'UNSUPPORTED_TTS_LANGUAGE';
    throw err;
  }

  const cleanText = params.text.trim().slice(0, 1800);
  if (!cleanText) {
    throw new Error('Text for speech synthesis cannot be empty.');
  }

  const voiceId = params.voiceId && /^[a-zA-Z0-9]{10,40}$/.test(params.voiceId)
    ? params.voiceId
    : DEFAULT_ELEVENLABS_VOICES[0].voice_id;

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.78,
          style: 0.15,
          use_speaker_boost: true,
        },
      }),
      signal: AbortSignal.timeout(20000),
    }
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`ElevenLabs TTS returned ${response.status}: ${detail.slice(0, 200)}`);
    (err as any).status = response.status;
    (err as any).code = response.status === 401 ? 'ELEVENLABS_AUTH_FAILED' : 'ELEVENLABS_TTS_FAILED';
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function transcribeWithElevenLabs(params: {
  audioBuffer: Buffer;
  mimeType: string;
  filename: string;
  language?: SupportedVoiceLanguage | 'auto';
}): Promise<{
  text: string;
  languageCode: string;
  languageProbability?: number;
}> {
  if (!isElevenLabsConfigured()) {
    const err = new Error('ELEVENLABS_API_KEY is not configured on the server.');
    (err as any).code = 'ELEVENLABS_KEY_MISSING';
    throw err;
  }

  const form = new FormData();
  const blob = new Blob([new Uint8Array(params.audioBuffer)], {
    type: params.mimeType || 'audio/webm',
  });
  form.append('file', blob, params.filename || 'recording.webm');
  form.append('model_id', 'scribe_v1');

  if (params.language && params.language !== 'auto') {
    const cap = VOICE_LANGUAGE_CAPABILITIES[params.language];
    if (cap?.sttLanguageCode) {
      form.append('language_code', cap.sttLanguageCode);
    }
  }

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY!,
    },
    body: form,
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const err = new Error(`ElevenLabs STT returned ${response.status}: ${detail.slice(0, 200)}`);
    (err as any).status = response.status;
    (err as any).code = response.status === 401 ? 'ELEVENLABS_AUTH_FAILED' : 'ELEVENLABS_STT_FAILED';
    throw err;
  }

  const data = (await response.json()) as {
    text?: string;
    language_code?: string;
    language_probability?: number;
  };

  return {
    text: (data.text || '').trim(),
    languageCode: data.language_code || 'eng',
    languageProbability: data.language_probability,
  };
}
