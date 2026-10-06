import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Item = { id: string; text: string };
type ContextItem = { source: string; target: string };
type TargetLanguage = "pl" | "en";

const STYLE: Record<string, { pl: string; en: string }> = {
  natural: {
    pl: "Naturalny polski dialog. Zachowuj sens, ton i rejestr. Nie tłumacz idiomów dosłownie.",
    en: "Natural English dialogue. Preserve meaning, tone and register. Do not translate idioms literally.",
  },
  faithful: {
    pl: "Tłumaczenie możliwie wierne znaczeniu oryginału, ale nadal naturalne po polsku.",
    en: "Keep the translation as faithful to the original meaning as possible while still sounding natural in English.",
  },
  film: {
    pl: "Filmowy, płynny polski. Idiomy i potoczne zwroty adaptuj tak, jak powiedziałby je Polak w tej scenie.",
    en: "Fluent cinematic English. Adapt idioms and colloquial phrases the way a native English speaker would say them in the scene.",
  },
};

function extractText(data: unknown): string {
  const root = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = root?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("");
}

function isRetryable(status: number) {
  return status === 404 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function uniqueModels() {
  const configured = process.env.GEMINI_MODEL?.trim();
  return Array.from(
    new Set([configured, "gemini-3.6-flash", "gemini-2.5-flash"].filter(Boolean))
  ) as string[];
}

async function requestGemini(args: {
  apiKey: string;
  model: string;
  systemInstruction: string;
  items: Item[];
  contextBefore: ContextItem[];
}) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      args.model
    )}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: args.systemInstruction }],
        },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: JSON.stringify({
                  contextBefore: args.contextBefore,
                  items: args.items,
                }),
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING" },
                text: { type: "STRING" },
              },
              required: ["id", "text"],
            },
          },
        },
      }),
    }
  );

  const data = await response.json();
  return { response, data };
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.TLUMACZ_KAY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Brak TLUMACZ_KAY na serwerze." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const items = body?.items as Item[];
    const contextBefore = (body?.contextBefore ?? []) as ContextItem[];
    const style = typeof body?.style === "string" ? body.style : "natural";
    const targetLanguage: TargetLanguage = body?.targetLanguage === "en" ? "en" : "pl";

    if (!Array.isArray(items) || items.length === 0 || items.length > 80) {
      return NextResponse.json(
        { error: "Nieprawidłowa paczka napisów." },
        { status: 400 }
      );
    }

    const ids = new Set<string>();
    for (const item of items) {
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.text !== "string" ||
        item.text.trim() === "" ||
        ids.has(item.id)
      ) {
        return NextResponse.json(
          { error: "Nieprawidłowy format segmentu." },
          { status: 400 }
        );
      }
      ids.add(item.id);
    }

    if (!Array.isArray(contextBefore) || contextBefore.length > 40) {
      return NextResponse.json(
        { error: "Nieprawidłowy kontekst." },
        { status: 400 }
      );
    }

    const sourceLanguage = targetLanguage === "pl" ? "angielskiego" : "polskiego";
    const targetLanguageName = targetLanguage === "pl" ? "polski" : "angielski";

    const systemInstruction = [
      `Jesteś profesjonalnym tłumaczem napisów filmowych z ${sourceLanguage} na ${targetLanguageName}.`,
      STYLE[style]?.[targetLanguage] ?? STYLE.natural[targetLanguage],
      "Tłumacz znaczenie wypowiedzi w kontekście sceny, nie słowo w słowo.",
      "Zachowuj imiona, nazwy własne, liczby i sens wypowiedzi.",
      "Nie dodawaj komentarzy, objaśnień ani informacji, których nie ma w dialogu.",
      "Nie zmieniaj identyfikatorów segmentów.",
      "Możesz użyć znaku nowej linii wewnątrz tłumaczenia, jeśli poprawia czytelność napisu.",
      "Zwróć dokładnie jeden element dla każdego wejściowego id, bez pomijania i bez duplikatów.",
      "Kontekst wcześniejszych kwestii służy wyłącznie do zachowania sensu i spójności; nie tłumacz go ponownie.",
    ].join("\n");

    let lastError = "Gemini nie odpowiedziało poprawnie.";
    let lastStatus = 502;

    for (const model of uniqueModels()) {
      const { response, data } = await requestGemini({
        apiKey,
        model,
        systemInstruction,
        items,
        contextBefore,
      });

      if (!response.ok) {
        const apiError = data as { error?: { message?: string } };
        lastError =
          apiError?.error?.message || `Gemini API zwróciło błąd ${response.status}.`;
        lastStatus = response.status;
        if (isRetryable(response.status)) continue;
        return NextResponse.json({ error: lastError }, { status: response.status });
      }

      const text = extractText(data);
      if (!text) {
        lastError = "Gemini nie zwróciło tekstu tłumaczenia.";
        lastStatus = 502;
        continue;
      }

      let translations: Item[];
      try {
        translations = JSON.parse(text) as Item[];
      } catch {
        lastError = "Nie udało się odczytać odpowiedzi JSON z Gemini.";
        lastStatus = 502;
        continue;
      }

      if (!Array.isArray(translations)) {
        lastError = "Gemini zwróciło nieprawidłowy format danych.";
        lastStatus = 502;
        continue;
      }

      const expected = new Set(items.map((item) => item.id));
      const received = new Map<string, string>();
      let invalid = false;

      for (const item of translations) {
        if (
          !item ||
          typeof item.id !== "string" ||
          typeof item.text !== "string" ||
          !expected.has(item.id) ||
          item.text.trim() === "" ||
          received.has(item.id)
        ) {
          invalid = true;
          break;
        }
        received.set(item.id, item.text.trim());
      }

      const missing = items.filter((item) => !received.has(item.id));
      if (invalid || translations.length !== items.length || missing.length) {
        lastError = missing.length
          ? `Gemini pominęło segmenty: ${missing
              .slice(0, 10)
              .map((item) => item.id)
              .join(", ")}`
          : "Gemini zwróciło niepełną lub zduplikowaną paczkę tłumaczenia.";
        lastStatus = 502;
        continue;
      }

      return NextResponse.json({
        translations: items.map((item) => ({
          id: item.id,
          text: received.get(item.id),
        })),
        model,
      });
    }

    return NextResponse.json({ error: lastError }, { status: lastStatus });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nieznany błąd serwera.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
