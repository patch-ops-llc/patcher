import { estimateTokens } from '../ai/models.js';
import { redact } from '../security/redact.js';

/**
 * "Evidence or nothing" for calls (design 10.3): a quote the model gives must be words that
 * are in the transcript. This finds them, and where in the call they were said.
 */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Shorter than this, a phrase could match by accident. */
export const MIN_QUOTE = 12;
const STAMP = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*/;

interface Indexed {
  text: string;
  /** Where each line starts in `text`, with the line's timestamp. */
  starts: { offset: number; at: string | null }[];
}

function build(lines: string[]): Indexed {
  const starts: Indexed['starts'] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const raw of lines) {
    const line = fold(raw);
    if (!line) continue;
    starts.push({ offset, at: STAMP.exec(line)?.[1] ?? null });
    parts.push(line);
    offset += line.length + 1;
  }
  return { text: parts.join(' '), starts };
}

export interface TranscriptIndex {
  /** Null when the words are not in the transcript. `at` is the timestamp of the line they start on. */
  find(quote: string): { at: string | null } | null;
}

export function indexTranscript(transcript: string): TranscriptIndex {
  const lines = transcript.split('\n');
  // The model reads the transcript after redaction, so its quote may match either form.
  const forms = [build(lines), build(lines.map(redact))];
  return {
    find(quote) {
      // A quote may come back with the line's own prefix or quotation marks around it.
      const wanted = fold(quote)
        .replace(STAMP, '')
        .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
        .trim();
      if (wanted.length < MIN_QUOTE) return null;
      for (const form of forms) {
        const found = form.text.indexOf(wanted);
        if (found < 0) continue;
        let at: string | null = null;
        for (const start of form.starts) {
          if (start.offset > found) break;
          at = start.at;
        }
        return { at };
      }
      return null;
    },
  };
}

/**
 * Cuts a long transcript to the token cap by leaving out the middle, on line boundaries.
 * The start (who is who, what the call is for) and the end (what was agreed) are kept.
 */
export function capTranscript(transcript: string, tokenCap: number): { text: string; omitted: number } {
  if (estimateTokens(transcript) <= tokenCap) return { text: transcript, omitted: 0 };
  const lines = transcript.split('\n');
  const budget = tokenCap * 4;
  const head: string[] = [];
  const tail: string[] = [];
  let headLength = 0;
  let tailLength = 0;
  let i = 0;
  let j = lines.length - 1;
  // Three parts from the start for every two from the end.
  while (i <= j) {
    const takeHead = headLength * 2 <= tailLength * 3;
    const line = takeHead ? lines[i]! : lines[j]!;
    if (headLength + tailLength + line.length + 1 > budget) break;
    if (takeHead) {
      head.push(line);
      headLength += line.length + 1;
      i += 1;
    } else {
      tail.push(line);
      tailLength += line.length + 1;
      j -= 1;
    }
  }
  tail.reverse();
  const omitted = j - i + 1;
  // One line longer than the whole budget: keep its start, so the model never gets nothing.
  if (!head.length && !tail.length) return { text: transcript.slice(0, budget), omitted: lines.length - 1 };
  return { text: [...head, `[… ${omitted} lines of the call are left out here …]`, ...tail].join('\n'), omitted };
}
