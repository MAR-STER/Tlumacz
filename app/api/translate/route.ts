import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Item = { id: string; text: string };
type ContextItem = { source: string; target: string };

const STYLE: Record<string, string> = {
  natural:
    "Naturalny polski dialog. Zachowuj sens, ton i rejestr. Nie tłumacz idiomów dosłownie.",
  faithful:
    "Tłumaczenie możliwie wierne znaczeniu oryginału, ale nadal naturalne po polsku.",
  film:
    "Filmowy, płynny polski. Idiomy i potoczne zwroty adaptuj tak, jak powiedziałby je Polak w tej scenie.",
};

function extractText(data: unknown): string {
  const root = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = root?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Brak GEMINI_API_KEY na serwerze. Dodaj klucz w zmiennych środowiskowych." },
        { status: 500 }
      );
    }

    const body = await request.json();
    const items = body?.items as Item[];
    const contextBefore = (body?.contextBefore ?? []) as ContextItem[];
    const style = typeof body?.style === "string" ? body.style : "natural";

    if (!Array.isArray(items) || items.length === 0 || items.length > 180) {
      return NextResponse.json({ error: "Nieprawidłowa paczka napisów." }, { status: 400 });
    }

    for (const item of items) {
      if (!item || typeof item.id !== "string" || typeof item.text !== "string") {
        return NextResponse.json({ error: "Nieprawidłowy format segmentu." }, { status: 400 });
      }
    }

    if (!Array.isArray(contextBefore) || contextBefore.length > 40) {
      return NextResponse.json({ error: "Nieprawidłowy kontekst." }, { status: 400 });
    }

    const model = process.env.GEMINI_MODEL || "gemini-3.6-flash";

    const systemInstruction = [
      "Jesteś profesjonalnym tłumaczem napisów filmowych z angielskiego na polski.",
      STYLE[style] ?? STYLE.natural,
      "Tłumacz znaczenie wypowiedzi w kontekście sceny, nie słowo w słowo.",
      "Zachowuj imiona, nazwy własne, liczby i sens wypowiedzi.",
      "Nie dodawaj komentarzy, objaśnień ani informacji, których nie ma w dialogu.",
      "Nie zmieniaj identyfikatorów segmentów.",
      "Możesz użyć znaku nowej linii wewnątrz tłumaczenia, jeśli poprawia czytelność napisu.",
      "Zwróć dokładnie jeden element dla każdego wejściowego id.",
      "Kontekst wcześniejszych kwestii służy wyłącznie do zachowania sensu i spójności; nie tłumacz go ponownie.",
    ].join("\n");

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        model
      )}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: JSON.stringify({ contextBefore, items }) }],
            },
          ],
          generationConfig: {
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

    if (!response.ok) {
      const apiError = data as { error?: { message?: string } };
      const message =
        apiError?.error?.message || `Gemini API zwróciło błąd ${response.status}.`;
      return NextResponse.json({ error: message }, { status: response.status });
    }

    const text = extractText(data);
    if (!text) {
      return NextResponse.json(
        { error: "Gemini nie zwróciło tekstu tłumaczenia." },
        { status: 502 }
      );
    }

    let translations: Item[];
    try {
      translations = JSON.parse(text) as Item[];
    } catch {
      return NextResponse.json(
        { error: "Nie udało się odczytać odpowiedzi JSON z Gemini." },
        { status: 502 }
      );
    }

    if (!Array.isArray(translations)) {
      return NextResponse.json({ error: "Gemini zwróciło nieprawidłowy format danych." }, { status: 502 });
    }

    const expected = new Set(items.map((item) => item.id));
    const received = new Map<string, string>();

    for (const item of translations) {
      if (
        item &&
        typeof item.id === "string" &&
        typeof item.text === "string" &&
        expected.has(item.id)
      ) {
        received.set(item.id, item.text.trim());
      }
    }

    const missing = items.filter((item) => !received.has(item.id)).map((item) => item.id);
    if (missing.length) {
      return NextResponse.json(
        { error: `Gemini pominęło segmenty: ${missing.slice(0, 10).join(", ")}` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      translations: items.map((item) => ({
        id: item.id,
        text: received.get(item.id),
      })),
      model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nieznany błąd serwera.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
