export type SubtitleFormat = "srt" | "vtt";
export type TargetLanguage = "pl" | "en";

export type SubtitleCue = {
  id: string;
  ordinal: number;
  start: string;
  end: string;
  text: string;
};

type Block =
  | { kind: "cue"; prefix: string[]; timing: string; suffix: string[]; cueId: string }
  | { kind: "meta"; lines: string[] };

export type SubtitleDocument = {
  format: SubtitleFormat;
  cues: SubtitleCue[];
  blocks: Block[];
};

function splitBlocks(input: string): string[][] {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }

  if (current.length) blocks.push(current);
  return blocks;
}

function parseTiming(line: string) {
  const arrow = line.indexOf("-->");
  if (arrow < 0) return null;

  const left = line.slice(0, arrow).trim();
  const right = line.slice(arrow + 3).trim();
  const rightParts = right.split(/\s+/);

  if (!left || !rightParts[0]) return null;
  return { start: left, end: rightParts[0] };
}

export function detectFormat(filename: string, raw: string): SubtitleFormat {
  const clean = raw.replace(/^\uFEFF/, "").trimStart();
  if (clean.startsWith("WEBVTT") || filename.toLowerCase().endsWith(".vtt")) return "vtt";
  return "srt";
}

export function parseSubtitles(raw: string, filename: string): SubtitleDocument {
  const format = detectFormat(filename, raw);
  const sourceBlocks = splitBlocks(raw);
  const cues: SubtitleCue[] = [];
  const blocks: Block[] = [];

  for (const lines of sourceBlocks) {
    if (format === "vtt" && lines[0]?.trim().startsWith("WEBVTT")) {
      blocks.push({ kind: "meta", lines });
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) {
      blocks.push({ kind: "meta", lines });
      continue;
    }

    const timing = parseTiming(lines[timingIndex]);
    if (!timing) {
      blocks.push({ kind: "meta", lines });
      continue;
    }

    const textLines = lines.slice(timingIndex + 1);
    if (!textLines.length) {
      blocks.push({ kind: "meta", lines });
      continue;
    }

    const cueId = `cue-${cues.length + 1}`;
    cues.push({
      id: cueId,
      ordinal: cues.length + 1,
      start: timing.start,
      end: timing.end,
      text: textLines.join("\n"),
    });

    blocks.push({
      kind: "cue",
      prefix: lines.slice(0, timingIndex),
      timing: lines[timingIndex],
      suffix: [],
      cueId,
    });
  }

  if (!cues.length) {
    throw new Error("Nie znaleziono prawidłowych segmentów napisów.");
  }

  return { format, cues, blocks };
}

export function renderSubtitles(
  doc: SubtitleDocument,
  translations: Map<string, string>
): string {
  const rendered = doc.blocks.map((block) => {
    if (block.kind === "meta") return block.lines.join("\n");

    const translated = translations.get(block.cueId);
    if (translated == null || translated.trim() === "") {
      throw new Error(`Brak tłumaczenia dla ${block.cueId}.`);
    }

    return [
      ...block.prefix,
      block.timing,
      ...translated.split("\n"),
      ...block.suffix,
    ].join("\n");
  });

  let output = rendered.join("\n\n").trimEnd() + "\n";
  if (doc.format === "vtt" && !output.trimStart().startsWith("WEBVTT")) {
    output = "WEBVTT\n\n" + output;
  }

  return output;
}

export function basename(path: string) {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || "napisy.srt";
}

export function outputFilename(
  filename: string,
  format: SubtitleFormat,
  targetLanguage: TargetLanguage
) {
  const ext = format === "vtt" ? ".vtt" : ".srt";
  const cleanName = basename(filename);
  const withoutExt = cleanName.replace(/\.(srt|vtt)$/i, "");
  const suffix = targetLanguage === "en" ? "EN" : "PL";
  return `${withoutExt}_${suffix}${ext}`;
}

export function zipFilename(
  filename: string,
  targetLanguage: TargetLanguage
) {
  const cleanName = basename(filename);
  const withoutExt = cleanName.replace(/\.(srt|vtt)$/i, "");
  const suffix = targetLanguage === "en" ? "EN" : "PL";
  return `${withoutExt}_${suffix}.zip`;
}
