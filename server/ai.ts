import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';

export function isGeminiConfigured(): boolean {
  const apiKey = process.env.GEMINI_API_KEY;
  return Boolean(apiKey && apiKey.trim().length > 8 && apiKey !== 'MY_GEMINI_API_KEY');
}

function getAiClient(apiVersion?: string): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
  return new GoogleGenAI({
    apiKey,
    ...(apiVersion ? { apiVersion } : {}),
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const AI_MODEL_CHAIN = ['gemini-3.1-flash-lite', 'gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;

function parseJsonResponse<T>(text: string | undefined, fallback: T): T {
  const cleaned = (text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  if (!cleaned) return fallback;
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

async function generateWithFallback(
  ai: GoogleGenAI,
  requestFactory: (model: string) => Parameters<GoogleGenAI['models']['generateContent']>[0]
) {
  let lastError: unknown;
  for (let i = 0; i < AI_MODEL_CHAIN.length; i++) {
    const model = AI_MODEL_CHAIN[i];
    try {
      const req = requestFactory(model);
      if (model === 'gemini-4-hydrogen') {
        req.config = {
          ...(req.config || {}),
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        };
      }
      const timeoutMs = model === 'gemini-3.1-flash-lite' ? 18000 : 20000;
      const response = await Promise.race([
        ai.models.generateContent(req),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`AI_TIMEOUT:${model}`)), timeoutMs)
        ),
      ]);
      return response;
    } catch (err: any) {
      lastError = err;
      const msg = String(err?.message || err || '');
      const status = err?.status || err?.code;
      const isTransient =
        status === 500 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        status === 429 ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('504') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('DEADLINE_EXCEEDED') ||
        msg.includes('high demand') ||
        msg.includes('429') ||
        msg.includes('fetch failed') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('AI_TIMEOUT');
      if (!isTransient) throw err;
      if (i < AI_MODEL_CHAIN.length - 1) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  throw lastError;
}

export const CIVIC_CATEGORIES = [
  'Roads and Potholes',
  'Waste Management',
  'Blocked Drains and Waterlogging',
  'Traffic and Road Obstructions',
  'Road Accident Reporting',
  'Medical Assistance',
  'Women and Child Safety',
  'Animal Rescue and Welfare',
] as const;

export const DEPARTMENT_BY_CATEGORY: Record<string, string> = {
  'Roads and Potholes': 'Public Works Department',
  'Waste Management': 'Municipal Corporation',
  'Blocked Drains and Waterlogging': 'Municipal Corporation',
  'Traffic and Road Obstructions': 'Traffic Police',
  'Road Accident Reporting': 'Emergency Control Room',
  'Medical Assistance': 'Medical Services',
  'Women and Child Safety': 'Police Department',
  'Animal Rescue and Welfare': 'Animal Welfare & Rescue',
};

export interface ReportAnalysisResult {
  suggestedCategory: string;
  suggestedSeverity: 'Low' | 'Medium' | 'High' | 'Critical';
  recommendedDepartment: string;
  summary: string;
  confidence: number;
  imageMatchesDescription: boolean;
  detectedIssueFromImage: string;
  fraudRiskScore: number;
  fraudRiskLevel: 'Low' | 'Moderate' | 'High' | 'Critical';
  fraudIndicators: string[];
  fraudExplanation: string;
  recommendedQueueAction: 'normal_routing' | 'additional_validation' | 'restricted_verification_queue' | 'fraud_investigation_queue';
  qualityNotes: string;
}

export async function analyzeCivicReport(params: {
  category: string;
  title: string;
  description: string;
  severity: string;
  address: string;
  lat: number;
  lng: number;
  photoBase64?: string;
  photoMimeType?: string;
  recentReportsContext: Array<{ id: string; title: string; category: string; lat: number; lng: number; description: string; imageHash?: string }>;
  currentImageHash?: string;
}): Promise<ReportAnalysisResult> {
  const ai = getAiClient();

  const nearbyOrSimilar = params.recentReportsContext
    .slice(0, 12)
    .map((r) => `- [${r.id}] (${r.category}) "${r.title}" at (${r.lat.toFixed(4)}, ${r.lng.toFixed(4)}): ${r.description.slice(0, 140)}`)
    .join('\n');

  const duplicateImageFound = Boolean(
    params.currentImageHash &&
    params.recentReportsContext.some((r) => r.imageHash && r.imageHash === params.currentImageHash)
  );

  const prompt = `You are SEVA AI & SEVA TRUST (Civic Intelligence & Report Integrity Engine for Indian cities).
Analyze the following civic report submission objectively. Never fabricate facts or establish guilt.

Submitted Data:
- User Selected Category: ${params.category}
- Incident Title: ${params.title}
- Description: ${params.description}
- User Selected Severity: ${params.severity}
- Address: ${params.address}
- GPS Coordinates: (${params.lat}, ${params.lng})
- Photo Attached: ${params.photoBase64 ? 'Yes (see attached image)' : 'No'}
- Exact Duplicate Image Hash Detected in Recent Reports: ${duplicateImageFound ? 'YES' : 'No'}

Recent Nearby/Existing Reports for Duplicate & Pattern Check:
${nearbyOrSimilar || 'None recorded yet.'}

Allowed Categories: ${CIVIC_CATEGORIES.join(', ')}
Allowed Severities: Low, Medium, High, Critical

Tasks:
1. Identify what the issue is (and what the image shows if attached).
2. Suggest the most accurate category and severity.
3. Recommend the municipal/safety department.
4. Provide a concise 1-2 sentence operational summary.
5. Compute a SEVA TRUST fraud risk score (0-100) based on:
   - Exact duplicate image hash (${duplicateImageFound ? '+45 risk' : '0'})
   - Repeated identical/near-identical description near same or mismatched GPS
   - Image vs description mismatch (if image is attached and shows something unrelated like a blank wall, meme, or completely different subject)
   - Nonsensical/spam/gibberish text or inconsistent location claim
   - Note: Missing photo alone is NOT fraud (only minor quality note, keep score < 25 if description is genuine).
6. Classify fraudRiskLevel:
   - 0-29: Low -> recommendedQueueAction: "normal_routing"
   - 30-59: Moderate -> recommendedQueueAction: "additional_validation"
   - 60-79: High -> recommendedQueueAction: "restricted_verification_queue"
   - 80-100: Critical -> recommendedQueueAction: "fraud_investigation_queue"`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
  if (params.photoBase64 && params.photoMimeType) {
    parts.push({
      inlineData: {
        mimeType: params.photoMimeType,
        data: params.photoBase64,
      },
    });
  }
  parts.push({ text: prompt });

  const response = await generateWithFallback(ai, (model) => ({
    model,
    contents: { parts },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          suggestedCategory: { type: Type.STRING },
          suggestedSeverity: { type: Type.STRING, enum: ['Low', 'Medium', 'High', 'Critical'] },
          recommendedDepartment: { type: Type.STRING },
          summary: { type: Type.STRING },
          confidence: { type: Type.NUMBER },
          imageMatchesDescription: { type: Type.BOOLEAN },
          detectedIssueFromImage: { type: Type.STRING },
          fraudRiskScore: { type: Type.INTEGER },
          fraudRiskLevel: { type: Type.STRING, enum: ['Low', 'Moderate', 'High', 'Critical'] },
          fraudIndicators: { type: Type.ARRAY, items: { type: Type.STRING } },
          fraudExplanation: { type: Type.STRING },
          recommendedQueueAction: {
            type: Type.STRING,
            enum: [
              'normal_routing',
              'additional_validation',
              'restricted_verification_queue',
              'fraud_investigation_queue',
            ],
          },
          qualityNotes: { type: Type.STRING },
        },
        required: [
          'suggestedCategory',
          'suggestedSeverity',
          'recommendedDepartment',
          'summary',
          'confidence',
          'imageMatchesDescription',
          'detectedIssueFromImage',
          'fraudRiskScore',
          'fraudRiskLevel',
          'fraudIndicators',
          'fraudExplanation',
          'recommendedQueueAction',
          'qualityNotes',
        ],
      },
    },
  }));

  const parsed = parseJsonResponse<ReportAnalysisResult>(response.text, {} as ReportAnalysisResult);
  const clampedScore = Math.max(0, Math.min(100, Math.round(parsed.fraudRiskScore ?? 10)));
  const validCat = CIVIC_CATEGORIES.includes(parsed.suggestedCategory as any)
    ? parsed.suggestedCategory
    : params.category;

  return {
    ...parsed,
    suggestedCategory: validCat,
    recommendedDepartment:
      DEPARTMENT_BY_CATEGORY[validCat] || parsed.recommendedDepartment || 'Municipal Corporation',
    fraudRiskScore: clampedScore,
  };
}

export interface SaathiAssistantResponse {
  replyText: string;
  detectedLanguage: string;
  intent: 'report_issue' | 'city_info' | 'complaint_status' | 'emergency_sos' | 'navigation' | 'authority_briefing' | 'general';
  extractedReport?: {
    category?: string;
    title?: string;
    description?: string;
    severity?: 'Low' | 'Medium' | 'High' | 'Critical';
    locationMentioned?: string;
    missingFields: string[];
  };
  navigationTarget?: 'home' | 'explore' | 'report' | 'shield' | 'heatmap' | 'rewards' | 'reports' | 'profile' | 'authority';
  shouldTriggerSosFlow?: boolean;
}

export async function processSaathiConversation(params: {
  userMessage: string;
  language: 'en' | 'hi' | 'bn' | 'as';
  history: Array<{ role: 'user' | 'assistant'; text: string }>;
  userContext: {
    isSignedIn: boolean;
    role: string;
    currentAddress?: string;
    lat?: number;
    lng?: number;
    myReportsSummary: Array<{ complaintId: string; title: string; category: string; status: string; updatedAt: string }>;
    authorityStatsSummary?: {
      total: number;
      pending: number;
      resolved: number;
      emergencies: number;
      recentHeadlines: string[];
    };
  };
}): Promise<SaathiAssistantResponse> {
  const ai = getAiClient();

  const languageNames: Record<string, string> = {
    en: 'English (Indian civic context)',
    hi: 'Hindi (Devanagari script, natural polite conversational Hindi)',
    bn: 'Bengali (Bengali script, clear polite Bengali)',
    as: 'Assamese (Assamese script, clear polite Assamese)',
  };

  const conversationSnippet = params.history
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'Citizen' : 'SEVA SAATHI'}: ${m.text}`)
    .join('\n');

  const systemInstruction = `You are SEVA SAATHI ("Your Voice, Your City, Your Seva"), the official multilingual AI civic voice assistant inside the SEVA AI smart city platform.

CRITICAL HONESTY & GROUNDING RULES:
1. Respond in ${languageNames[params.language] || 'English'}. Never silently switch to an unrelated language.
2. Keep spoken replies concise, warm, calm, clear, and helpful (2-4 sentences max so ElevenLabs TTS sounds natural and crisp).
3. NEVER fabricate complaint IDs, government approvals, authority responses, or claim that an SOS or report has already been submitted if the user hasn't confirmed it in the UI.
4. For complaint status queries, ONLY cite actual reports from the provided "User's Real Reports" context. If none match or user is not signed in, say so honestly.
5. For Authority Dashboard briefings, ONLY cite numbers from "Authority Dashboard Real Stats".
6. Verified SEVA AI platform workflows you can explain accurately:
   - Potholes / Roads: Open "Report an Issue" -> Roads and Potholes, capture live GPS + optional photo, review AI suggestions, and confirm submission.
   - Waste Management / Blocked Drains / Traffic / Animal Rescue: Dedicated categories in "Report an Issue" with automatic department routing.
   - After submission: Report goes through Gemini AI analysis and SEVA TRUST integrity screening, receives a unique Complaint ID, routes to the department, and updates live in "My Reports".
   - Women & Child Safety / Emergency: "Seva Shield" offers a 2-second hold SOS button (with 5-second cancel countdown), up to 5 trusted Indian phone contacts, live GPS link sharing, and "I'm Safe" resolution. Never claim emergency dispatch occurred automatically from chat; guide or set shouldTriggerSosFlow=true to open the real Seva Shield confirmation workflow.
   - Explore City: Uses live GPS + OpenStreetMap Overpass API with 500m to 50km radius selection.
7. If the user is describing a civic problem (pothole, garbage, drain, traffic obstruction, accident, animal rescue, safety concern), set intent="report_issue" and populate extractedReport with category (must match one of: ${CIVIC_CATEGORIES.join(', ')}), concise title, clean description, severity, locationMentioned (only if stated by user; otherwise empty string — NEVER invent a location), and missingFields (e.g. ["location"] if no GPS acquired and no location mentioned, or ["photo_optional", "confirmation"]).
8. If user asks to open a section (e.g. "open nearby hospitals", "go to safety map", "open my reports"), set intent="navigation" and navigationTarget.`;

  const contextBlock = `Current Context:
- Signed In: ${params.userContext.isSignedIn} (Role: ${params.userContext.role})
- Current Live GPS Location: ${params.userContext.lat && params.userContext.lng ? `${params.userContext.currentAddress || 'Acquired'} (${params.userContext.lat.toFixed(5)}, ${params.userContext.lng.toFixed(5)})` : 'Not acquired yet'}
- User's Real Reports: ${params.userContext.myReportsSummary.length ? JSON.stringify(params.userContext.myReportsSummary.slice(0, 8)) : 'No reports found'}
- Authority Dashboard Real Stats: ${params.userContext.authorityStatsSummary ? JSON.stringify(params.userContext.authorityStatsSummary) : 'N/A'}

Recent Conversation:
${conversationSnippet || 'None'}

Latest User Utterance:
${params.userMessage}`;

  const fullPrompt = `${systemInstruction}

${contextBlock}

Output JSON schema notes:
- If intent == "report_issue", fill extractedCategory, extractedTitle, extractedDescription, extractedSeverity, extractedLocation, extractedMissingFields. Otherwise leave them empty strings / empty array.
- If intent == "navigation", set navigationTarget to one of home, explore, report, shield, heatmap, rewards, reports, profile, authority. Otherwise "home".
- Set shouldTriggerSosFlow true ONLY when citizen explicitly needs SOS workflow opened.`;

  const response = await generateWithFallback(ai, (model) => ({
    model,
    contents: { parts: [{ text: fullPrompt }] },
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          replyText: { type: Type.STRING },
          detectedLanguage: { type: Type.STRING },
          intent: {
            type: Type.STRING,
            enum: [
              'report_issue',
              'city_info',
              'complaint_status',
              'emergency_sos',
              'navigation',
              'authority_briefing',
              'general',
            ],
          },
          extractedCategory: { type: Type.STRING },
          extractedTitle: { type: Type.STRING },
          extractedDescription: { type: Type.STRING },
          extractedSeverity: { type: Type.STRING, enum: ['Low', 'Medium', 'High', 'Critical'] },
          extractedLocation: { type: Type.STRING },
          extractedMissingFields: { type: Type.ARRAY, items: { type: Type.STRING } },
          navigationTarget: {
            type: Type.STRING,
            enum: ['home', 'explore', 'report', 'shield', 'heatmap', 'rewards', 'reports', 'profile', 'authority'],
          },
          shouldTriggerSosFlow: { type: Type.BOOLEAN },
        },
        required: ['replyText', 'detectedLanguage', 'intent'],
      },
    },
  }));

  const raw = parseJsonResponse<{
    replyText: string;
    detectedLanguage: string;
    intent: SaathiAssistantResponse['intent'];
    extractedCategory?: string;
    extractedTitle?: string;
    extractedDescription?: string;
    extractedSeverity?: 'Low' | 'Medium' | 'High' | 'Critical';
    extractedLocation?: string;
    extractedMissingFields?: string[];
    navigationTarget?: SaathiAssistantResponse['navigationTarget'];
    shouldTriggerSosFlow?: boolean;
  }>(response.text, {
    replyText: 'How can SEVA SAATHI assist you today?',
    detectedLanguage: params.language,
    intent: 'general',
  });

  const result: SaathiAssistantResponse = {
    replyText: raw.replyText || 'How can SEVA SAATHI assist you today?',
    detectedLanguage: raw.detectedLanguage || params.language,
    intent: raw.intent || 'general',
    shouldTriggerSosFlow: Boolean(raw.shouldTriggerSosFlow),
  };

  if (raw.intent === 'navigation' && raw.navigationTarget) {
    result.navigationTarget = raw.navigationTarget;
  }

  if (raw.intent === 'report_issue' && (raw.extractedTitle || raw.extractedDescription || raw.extractedCategory)) {
    result.extractedReport = {
      category: CIVIC_CATEGORIES.includes(raw.extractedCategory as any) ? raw.extractedCategory : undefined,
      title: raw.extractedTitle || undefined,
      description: raw.extractedDescription || undefined,
      severity: raw.extractedSeverity || 'Medium',
      locationMentioned: raw.extractedLocation || undefined,
      missingFields: Array.isArray(raw.extractedMissingFields) ? raw.extractedMissingFields : [],
    };
  }

  return result;
}

const ELEVENLABS_TO_GEMINI_VOICE: Record<string, string> = {
  '21m00Tcm4TlvDq8ikWAM': 'Kore',
  EXAVITQu4vr4xnSDxMaL: 'Zephyr',
  pNInz6obpgDQGcFmaJgB: 'Charon',
  IKne3meq5aSn9XLyUdCD: 'Puck',
};

export async function synthesizeWithGemini(params: {
  text: string;
  voiceId?: string;
  language?: 'en' | 'hi' | 'bn' | 'as';
}): Promise<Buffer> {
  const ai = getAiClient('v1beta');
  const cleanText = params.text.trim().slice(0, 1800);
  if (!cleanText) {
    throw new Error('Text for speech synthesis cannot be empty.');
  }

  const prebuiltVoice = (params.voiceId && ELEVENLABS_TO_GEMINI_VOICE[params.voiceId]) || 'Kore';

  const response = await Promise.race([
    ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: cleanText,
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: prebuiltVoice },
          },
        },
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Gemini TTS request timed out.')), 22000)
    ),
  ]);

  const parts = response.candidates?.[0]?.content?.parts || [];
  const audioPart = parts.find((p: any) => p?.inlineData?.data);
  const base64Audio = audioPart?.inlineData?.data;
  if (!base64Audio) {
    throw new Error('Gemini TTS returned no audio data.');
  }

  return Buffer.from(base64Audio, 'base64');
}

export async function transcribeWithGemini(params: {
  audioBuffer: Buffer;
  mimeType: string;
  language?: 'en' | 'hi' | 'bn' | 'as' | 'auto';
}): Promise<{ text: string; languageCode: string }> {
  const aiBeta = getAiClient('v1beta');
  const aiDefault = getAiClient();
  const langHint =
    params.language === 'hi'
      ? 'Hindi'
      : params.language === 'bn'
      ? 'Bengali'
      : params.language === 'as'
      ? 'Assamese'
      : params.language === 'en'
      ? 'English'
      : 'the spoken language (English, Hindi, Bengali, or Assamese)';

  const base64Audio = params.audioBuffer.toString('base64');
  const mime = (params.mimeType || 'audio/webm').split(';')[0].trim() || 'audio/webm';

  const contents = {
    parts: [
      {
        inlineData: {
          mimeType: mime,
          data: base64Audio,
        },
      },
      {
        text: `Transcribe the spoken speech accurately into plain text in ${langHint}. Return only the verbatim spoken transcript without commentary or timestamps. If no intelligible speech is present, return an empty string.`,
      },
    ],
  };

  let responseText = '';
  const attempts: Array<{ client: GoogleGenAI; model: string }> = [
    { client: aiBeta, model: 'gemini-3.5-transcribe' },
    { client: aiDefault, model: 'gemini-3.1-flash-lite' },
  ];

  let lastErr: unknown;
  for (const attempt of attempts) {
    try {
      const response = await Promise.race([
        attempt.client.models.generateContent({
          model: attempt.model,
          contents,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini audio transcription timed out (${attempt.model}).`)), 22000)
        ),
      ]);
      responseText = (response.text || '').trim().replace(/^["']|["']$/g, '');
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) {
    throw lastErr;
  }

  const langCodeMap: Record<string, string> = {
    en: 'eng',
    hi: 'hin',
    bn: 'ben',
    as: 'asm',
    auto: 'auto',
  };

  return {
    text: responseText,
    languageCode: langCodeMap[params.language || 'auto'] || 'eng',
  };
}

