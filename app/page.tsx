"use client";

import { useMemo, useRef, useState } from "react";
import {
  outputFilename,
  parseSubtitles,
  renderSubtitles,
  type SubtitleDocument,
} from "../lib/subtitles";

type Translation = { id: string; text: string };

const BATCH_SIZE = 80;
const CONTEXT_SIZE = 12;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [doc, setDoc] = useState<SubtitleDocument | null>(null);
  const [style, setStyle] = useState("natural");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Wybierz plik .srt lub .vtt");
  const [running, setRunning] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const stopRef = useRef(false);

  const batches = useMemo(
    () => (doc ? Math.ceil(doc.cues.length / BATCH_SIZE) : 0),
    [doc]
  );

  async function onFile(next: File | null) {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setProgress(0);
    setFile(next);
    setDoc(null);

    if (!next) {
      setStatus("Wybierz plik .srt lub .vtt");
      return;
    }

    try {
      const raw = await next.text();
      const parsed = parseSubtitles(raw, next.name);
      setDoc(parsed);
      setStatus(
        `${parsed.cues.length} segmentów • ${parsed.format.toUpperCase()} • około ${Math.ceil(
          parsed.cues.length / BATCH_SIZE
        )} paczek`
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Nie udało się odczytać pliku.");
    }
  }

  async function translateBatch(
    items: { id: string; text: string }[],
    contextBefore: { source: string; target: string }[]
  ): Promise<Translation[]> {
    let lastError = "Błąd tłumaczenia.";

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch("/api/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items, contextBefore, style }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        if (!Array.isArray(data?.translations)) {
          throw new Error("Serwer zwrócił nieprawidłową odpowiedź.");
        }
        return data.translations as Translation[];
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
        if (attempt < 3) await sleep(1200 * attempt);
      }
    }
    throw new Error(lastError);
  }

  async function start() {
    if (!doc || !file || running) return;

    setRunning(true);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setProgress(0);
    stopRef.current = false;
    const translated = new Map<string, string>();

    try {
      for (let offset = 0; offset < doc.cues.length; offset += BATCH_SIZE) {
        if (stopRef.current) {
          setStatus("Tłumaczenie zatrzymane.");
          return;
        }

        const current = doc.cues.slice(offset, offset + BATCH_SIZE);
        const previous = doc.cues.slice(Math.max(0, offset - CONTEXT_SIZE), offset);
        const contextBefore = previous
          .filter((cue) => translated.has(cue.id))
          .map((cue) => ({ source: cue.text, target: translated.get(cue.id)! }));

        const batchNo = Math.floor(offset / BATCH_SIZE) + 1;
        setStatus(`Tłumaczenie paczki ${batchNo}/${batches}…`);

        const result = await translateBatch(
          current.map((cue) => ({ id: cue.id, text: cue.text })),
          contextBefore
        );

        for (const item of result) translated.set(item.id, item.text);

        const done = Math.min(offset + current.length, doc.cues.length);
        setProgress(Math.round((done / doc.cues.length) * 100));
      }

      const output = renderSubtitles(doc, translated);
      const blob = new Blob([output], {
        type:
          doc.format === "vtt"
            ? "text/vtt;charset=utf-8"
            : "application/x-subrip;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);

      setDownloadUrl(url);
      setDownloadName(outputFilename(file.name, doc.format));
      setStatus("Gotowe. Plik został przetłumaczony i scalony.");
      setProgress(100);
    } catch (error) {
      setStatus(
        error instanceof Error ? `Błąd: ${error.message}` : "Wystąpił nieznany błąd."
      );
    } finally {
      setRunning(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">MAR-STER • AI Subtitle Translator</p>
          <h1>Tłumacz napisów</h1>
          <p className="lead">
            Kontekstowe tłumaczenie angielskich napisów na naturalny polski.
            Obsługa SRT i VTT, tłumaczenie partiami i automatyczne scalenie gotowego pliku.
          </p>
        </div>
        <div className="badge">EN → PL</div>
      </section>

      <section className="card">
        <label className="drop">
          <input
            type="file"
            accept=".srt,.vtt,application/x-subrip,text/vtt"
            disabled={running}
            onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
          />
          <span className="dropTitle">
            {file ? file.name : "Wybierz plik napisów"}
          </span>
          <span className="dropHint">SRT lub WebVTT (.vtt)</span>
        </label>

        <div className="controls">
          <label>
            Styl tłumaczenia
            <select
              value={style}
              onChange={(event) => setStyle(event.target.value)}
              disabled={running}
            >
              <option value="natural">Naturalny</option>
              <option value="faithful">Wierny oryginałowi</option>
              <option value="film">Filmowy</option>
            </select>
          </label>

          <div className="stat"><span>Segmenty</span><strong>{doc?.cues.length ?? "—"}</strong></div>
          <div className="stat"><span>Paczki</span><strong>{batches || "—"}</strong></div>
          <div className="stat"><span>Format</span><strong>{doc?.format.toUpperCase() ?? "—"}</strong></div>
        </div>

        <div className="progressTrack" aria-label="Postęp tłumaczenia">
          <div className="progressBar" style={{ width: `${progress}%` }} />
        </div>

        <div className="statusRow">
          <span>{status}</span>
          <strong>{progress}%</strong>
        </div>

        <div className="actions">
          <button className="primary" onClick={() => void start()} disabled={!doc || running}>
            {running ? "Tłumaczenie…" : "Tłumacz"}
          </button>

          {running && (
            <button
              className="secondary"
              onClick={() => {
                stopRef.current = true;
                setStatus("Zatrzymywanie po bieżącej paczce…");
              }}
            >
              Zatrzymaj
            </button>
          )}

          {downloadUrl && (
            <a className="download" href={downloadUrl} download={downloadName}>
              Pobierz {downloadName}
            </a>
          )}
        </div>
      </section>

      <section className="info">
        <article>
          <h2>Kontekst między paczkami</h2>
          <p>Każda kolejna paczka dostaje poprzednie kwestie wraz z ich polskim tłumaczeniem.</p>
        </article>
        <article>
          <h2>Synchronizacja bez zmian</h2>
          <p>Timestamps i ustawienia cue pozostają po stronie aplikacji. AI tłumaczy wyłącznie tekst.</p>
        </article>
        <article>
          <h2>SRT i VTT</h2>
          <p>Program rozpoznaje format i zapisuje wynik w tym samym formacie co plik wejściowy.</p>
        </article>
      </section>
    </main>
  );
}
