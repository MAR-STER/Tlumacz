"use client";

import JSZip from "jszip";
import { useMemo, useRef, useState } from "react";
import {
  basename,
  outputFilename,
  parseSubtitles,
  renderSubtitles,
  zipFilename,
  type SubtitleDocument,
  type TargetLanguage,
} from "../lib/subtitles";

type Translation = { id: string; text: string };
type LanguagePair = "en-pl" | "pl-en";

const BATCH_SIZE = 40;
const CONTEXT_SIZE = 10;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function subtitleExtension(name: string) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".srt")) return "srt";
  if (lower.endsWith(".vtt")) return "vtt";
  return null;
}

export default function Home() {
  const [sourceName, setSourceName] = useState("");
  const [inputContainerName, setInputContainerName] = useState("");
  const [doc, setDoc] = useState<SubtitleDocument | null>(null);
  const [style, setStyle] = useState("natural");
  const [languagePair, setLanguagePair] = useState<LanguagePair>("en-pl");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Wybierz plik .srt, .vtt lub .zip");
  const [running, setRunning] = useState(false);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadName, setDownloadName] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pastedText, setPastedText] = useState("");
  const stopRef = useRef(false);

  const batches = useMemo(
    () => (doc ? Math.ceil(doc.cues.length / BATCH_SIZE) : 0),
    [doc]
  );

  const targetLanguage: TargetLanguage = languagePair === "pl-en" ? "en" : "pl";

  function clearOutput() {
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    setDownloadUrl(null);
    setDownloadName("");
    setProgress(0);
  }

  function loadParsed(raw: string, filename: string, containerName = "") {
    const parsed = parseSubtitles(raw, filename);
    setSourceName(basename(filename));
    setInputContainerName(containerName);
    setDoc(parsed);
    setStatus(
      `${parsed.cues.length} segmentów • ${parsed.format.toUpperCase()} • ${Math.ceil(
        parsed.cues.length / BATCH_SIZE
      )} paczek${containerName ? ` • z ${containerName}` : ""}`
    );
  }

  async function onFile(next: File | null) {
    clearOutput();
    setDoc(null);
    setSourceName("");
    setInputContainerName("");

    if (!next) {
      setStatus("Wybierz plik .srt, .vtt lub .zip");
      return;
    }

    try {
      const lower = next.name.toLowerCase();

      if (lower.endsWith(".zip")) {
        setStatus("Odczytuję archiwum ZIP…");
        const zip = await JSZip.loadAsync(await next.arrayBuffer());
        const subtitleEntries = Object.values(zip.files).filter(
          (entry) => !entry.dir && subtitleExtension(entry.name)
        );

        if (!subtitleEntries.length) {
          throw new Error("ZIP nie zawiera pliku .srt ani .vtt.");
        }
        if (subtitleEntries.length > 1) {
          throw new Error(
            `ZIP zawiera ${subtitleEntries.length} pliki napisów. Umieść w archiwum dokładnie jeden plik .srt lub .vtt.`
          );
        }

        const entry = subtitleEntries[0];
        const raw = await entry.async("string");
        loadParsed(raw, entry.name, next.name);
        return;
      }

      if (!subtitleExtension(next.name)) {
        throw new Error("Obsługiwane są pliki .srt, .vtt oraz .zip.");
      }

      loadParsed(await next.text(), next.name);
    } catch (error) {
      setStatus(error instanceof Error ? `Błąd: ${error.message}` : "Nie udało się odczytać pliku.");
    }
  }

  function loadPasted() {
    clearOutput();
    try {
      const trimmed = pastedText.trim();
      if (!trimmed) throw new Error("Pole z napisami jest puste.");
      const filename = /^WEBVTT\b/i.test(trimmed) ? "wklejone.vtt" : "wklejone.srt";
      loadParsed(pastedText, filename);
      setPasteOpen(false);
    } catch (error) {
      setStatus(error instanceof Error ? `Błąd: ${error.message}` : "Nie udało się odczytać napisów.");
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
          body: JSON.stringify({
            items,
            contextBefore,
            style,
            targetLanguage,
          }),
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || `HTTP ${response.status}`);
        }
        if (!Array.isArray(data?.translations)) {
          throw new Error("Serwer zwrócił nieprawidłową odpowiedź.");
        }

        const translations = data.translations as Translation[];
        const expected = new Set(items.map((item) => item.id));
        const received = new Set<string>();

        for (const item of translations) {
          if (
            !item ||
            typeof item.id !== "string" ||
            typeof item.text !== "string" ||
            item.text.trim() === "" ||
            !expected.has(item.id) ||
            received.has(item.id)
          ) {
            throw new Error("Serwer zwrócił niepełną lub zduplikowaną paczkę.");
          }
          received.add(item.id);
        }

        if (translations.length !== items.length || received.size !== items.length) {
          throw new Error(
            `Niepełna paczka: otrzymano ${received.size}/${items.length} segmentów.`
          );
        }

        return translations;
      } catch (error) {
        lastError = error instanceof Error ? error.message : lastError;
        if (attempt < 3) await sleep(1200 * attempt);
      }
    }

    throw new Error(lastError);
  }

  async function start() {
    if (!doc || !sourceName || running) return;

    setRunning(true);
    clearOutput();
    stopRef.current = false;
    const translated = new Map<string, string>();

    try {
      for (let offset = 0; offset < doc.cues.length; offset += BATCH_SIZE) {
        if (stopRef.current) {
          setStatus("Tłumaczenie zatrzymane. Nie utworzono niepełnego pliku.");
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

        for (const item of result) translated.set(item.id, item.text.trim());

        const expectedDone = Math.min(offset + current.length, doc.cues.length);
        if (translated.size !== expectedDone) {
          throw new Error(
            `Kontrola kompletności nie powiodła się: ${translated.size}/${expectedDone}.`
          );
        }

        setProgress(Math.round((expectedDone / doc.cues.length) * 100));
      }

      if (translated.size !== doc.cues.length) {
        throw new Error(
          `Tłumaczenie jest niekompletne: ${translated.size}/${doc.cues.length} segmentów.`
        );
      }

      for (const cue of doc.cues) {
        if (!translated.get(cue.id)?.trim()) {
          throw new Error(`Brak tłumaczenia dla segmentu ${cue.ordinal}.`);
        }
      }

      setStatus("Sprawdzam kompletność i tworzę archiwum ZIP…");
      const output = renderSubtitles(doc, translated);
      const subtitleName = outputFilename(sourceName, doc.format, targetLanguage);
      const archiveName = zipFilename(sourceName, targetLanguage);

      const zip = new JSZip();
      zip.file(subtitleName, output);
      const blob = await zip.generateAsync({
        type: "blob",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      const url = URL.createObjectURL(blob);

      setDownloadUrl(url);
      setDownloadName(archiveName);
      setStatus(
        `Gotowe. Sprawdzono ${doc.cues.length}/${doc.cues.length} segmentów. Wynik zapisano w ZIP.`
      );
      setProgress(100);
    } catch (error) {
      clearOutput();
      setStatus(
        error instanceof Error ? `Błąd: ${error.message}` : "Wystąpił nieznany błąd."
      );
    } finally {
      setRunning(false);
    }
  }

  const directionLabel = languagePair === "pl-en" ? "PL → EN" : "EN → PL";

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">MAR-STER • AI Subtitle Translator</p>
          <h1>Tłumacz napisów</h1>
          <p className="lead">
            Tłumaczenie SRT i VTT między polskim i angielskim. Importuj bezpośrednio plik napisów
            albo ZIP. Gotowy wynik jest zawsze sprawdzany i pakowany do ZIP przed pobraniem.
          </p>
        </div>
        <div className="badge">{directionLabel}</div>
      </section>

      <section className="card">
        <label className="drop">
          <input
            type="file"
            accept=".srt,.vtt,.zip,application/x-subrip,text/vtt,application/zip,application/x-zip-compressed"
            disabled={running}
            onChange={(event) => void onFile(event.target.files?.[0] ?? null)}
          />
          <span className="dropTitle">
            {sourceName
              ? inputContainerName
                ? `${inputContainerName} → ${sourceName}`
                : sourceName
              : "Wybierz plik napisów lub ZIP"}
          </span>
          <span className="dropHint">SRT, WebVTT lub ZIP zawierający jeden plik SRT/VTT</span>
        </label>

        <div className="pasteActions">
          <button
            className="secondary"
            type="button"
            disabled={running}
            onClick={() => setPasteOpen((value) => !value)}
          >
            {pasteOpen ? "Ukryj wklejanie" : "Wklej napisy ręcznie"}
          </button>
        </div>

        {pasteOpen && (
          <div className="pastePanel">
            <textarea
              value={pastedText}
              onChange={(event) => setPastedText(event.target.value)}
              placeholder="Wklej tutaj pełną zawartość pliku SRT lub VTT…"
              disabled={running}
            />
            <button className="secondary" type="button" onClick={loadPasted} disabled={running}>
              Załaduj wklejone napisy
            </button>
          </div>
        )}

        <div className="controls">
          <label>
            Kierunek
            <select
              value={languagePair}
              onChange={(event) => setLanguagePair(event.target.value as LanguagePair)}
              disabled={running}
            >
              <option value="en-pl">Angielski → polski</option>
              <option value="pl-en">Polski → angielski</option>
            </select>
          </label>

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

          <div className="stat">
            <span>Segmenty</span>
            <strong>{doc?.cues.length ?? "—"}</strong>
          </div>
          <div className="stat">
            <span>Paczki</span>
            <strong>{batches || "—"}</strong>
          </div>
          <div className="stat">
            <span>Format</span>
            <strong>{doc?.format.toUpperCase() ?? "—"}</strong>
          </div>
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
              Pobierz ZIP: {downloadName}
            </a>
          )}
        </div>
      </section>

      <section className="info">
        <article>
          <h2>Import ZIP</h2>
          <p>Możesz wskazać ZIP zawierający jeden plik SRT lub VTT. Archiwum jest rozpakowywane w przeglądarce.</p>
        </article>
        <article>
          <h2>Kontrola kompletności</h2>
          <p>Każda paczka jest sprawdzana. Pobieranie pojawia się dopiero po przetłumaczeniu wszystkich segmentów.</p>
        </article>
        <article>
          <h2>Eksport ZIP</h2>
          <p>Gotowy SRT lub VTT jest automatycznie pakowany do ZIP i dopiero wtedy udostępniany do pobrania.</p>
        </article>
      </section>
    </main>
  );
}
