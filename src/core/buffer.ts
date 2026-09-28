/**
 * core/buffer.ts — byte-bounded, UTF-8-safe text retention.
 *
 * The previous implementation kept an array of chunks and spliced from the
 * middle when over budget, which had two real defects:
 *
 *  1. The byte counter only ever grew, so once the limit was crossed EVERY
 *     subsequent append triggered another splice — the "limit" was not
 *     actually a limit.
 *  2. A single chunk larger than the whole limit was never split, so a 5 MB
 *     tool result blew straight through the cap.
 *
 * This version keeps a hard byte ceiling at all times and trims by CODE POINT,
 * so a multi-byte character or a surrogate pair is never cut in half.
 */

export interface TailBufferOptions {
  /** Hard ceiling in bytes of UTF-8. */
  readonly limitBytes: number;
  /** Trim from the start (default) or the end. */
  readonly keep?: 'tail' | 'head';
}

export class TailBuffer {
  private text = '';
  private bytes = 0;
  private truncatedFlag = false;
  private readonly limitBytes: number;
  private readonly keep: 'tail' | 'head';

  constructor(options: TailBufferOptions) {
    this.limitBytes = Math.max(0, Math.floor(options.limitBytes));
    this.keep = options.keep ?? 'tail';
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get isEmpty(): boolean {
    return this.text.length === 0;
  }

  append(chunk: string): void {
    if (!chunk) return;
    if (this.limitBytes === 0) {
      this.truncatedFlag = true;
      return;
    }
    const chunkBytes = byteLen(chunk);
    if (chunkBytes >= this.limitBytes) {
      // The chunk alone exceeds the budget: keep only the part that fits.
      // trimTo fits code points, so a multi-byte char is never split.
      const fit = this.keep === 'tail' ? takeTailBytes(chunk, this.limitBytes) : takeHeadBytes(chunk, this.limitBytes);
      this.text = fit;
      this.bytes = byteLen(fit);
      this.truncatedFlag = true;
      return;
    }

    this.text += chunk;
    this.bytes += chunkBytes;
    this.enforce();
  }

  private enforce(): void {
    if (this.bytes <= this.limitBytes) return;
    this.text = this.keep === 'tail' ? takeTailBytes(this.text, this.limitBytes) : takeHeadBytes(this.text, this.limitBytes);
    this.bytes = byteLen(this.text);
    this.truncatedFlag = true;
  }

  toString(): string {
    return this.text;
  }

  /** Drop the in-memory copy. The transcript on disk is unaffected. */
  release(): void {
    this.text = '';
    this.bytes = 0;
  }
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Longest suffix of `s` that fits in `limitBytes`, without splitting a code
 * point. Iterating with `for..of` yields whole code points, so surrogate pairs
 * stay intact.
 */
export function takeTailBytes(s: string, limitBytes: number): string {
  if (limitBytes <= 0) return '';
  if (byteLen(s) <= limitBytes) return s;
  const points = Array.from(s);
  let used = 0;
  let start = points.length;
  for (let i = points.length - 1; i >= 0; i--) {
    const size = byteLen(points[i]!);
    if (used + size > limitBytes) break;
    used += size;
    start = i;
  }
  return points.slice(start).join('');
}

/** Longest prefix of `s` that fits in `limitBytes`, without splitting a point. */
export function takeHeadBytes(s: string, limitBytes: number): string {
  if (limitBytes <= 0) return '';
  if (byteLen(s) <= limitBytes) return s;
  const points = Array.from(s);
  let used = 0;
  let end = 0;
  for (let i = 0; i < points.length; i++) {
    const size = byteLen(points[i]!);
    if (used + size > limitBytes) break;
    used += size;
    end = i + 1;
  }
  return points.slice(0, end).join('');
}
