# Tłumacz napisów AI

Strona WWW do kontekstowego tłumaczenia napisów z angielskiego na polski.

## Obsługiwane formaty

- SRT (`.srt`)
- WebVTT (`.vtt`)

Format wyjściowy jest taki sam jak wejściowy. Czasy oraz ustawienia cue pozostają bez zmian — AI tłumaczy wyłącznie tekst dialogów.

## Jak działa

1. Przeglądarka odczytuje plik napisów.
2. Napisy są dzielone na paczki po 80 segmentów.
3. Każda następna paczka dostaje 12 poprzednich kwestii wraz z polskim tłumaczeniem jako kontekst.
4. Backend wysyła tekst do Gemini.
5. Aplikacja sprawdza, czy AI zwróciło każdy segment.
6. Wynik jest składany do jednego pliku `*_PL.srt` lub `*_PL.vtt`.

## Uruchomienie lokalne

Wymagany Node.js 20+.

```bash
npm install
cp .env.example .env.local
npm run dev
```

W `.env.local` ustaw:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

Klucz Gemini jest używany tylko po stronie serwera i nie trafia do kodu wykonywanego w przeglądarce.

## Vercel

Po imporcie repozytorium do Vercel dodaj zmienne:

- `GEMINI_API_KEY`
- `GEMINI_MODEL` — opcjonalnie; domyślnie `gemini-3.6-flash`

Potem wykonaj deploy.
