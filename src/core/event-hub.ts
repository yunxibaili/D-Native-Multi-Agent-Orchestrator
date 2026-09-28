/**
 * core/event-hub.ts — bounded, multi-subscriber fan-out.
 *
 * Replaces a destructive single-consumer queue. Requirements it satisfies:
 *
 *  - Subscriber A cannot consume subscriber B's events. Each subscriber owns
 *    an independent ring buffer.
 *  - A slow subscriber NEVER blocks the producer and never stalls other
 *    subscribers. Overflow is resolved per-subscriber, on publish.
 *  - Every buffer is bounded. The hub keeps a small bounded "recent" ring so a
 *    late subscriber has a defined, opt-in replay semantic.
 *  - `close()` completes every subscriber and frees every buffer, so nothing
 *    is retained after a terminal state.
 *
 * No external event bus. This is a single-process object; a hub is created per
 * execution and is garbage after `close()`.
 */

import type { SubscribeOptions } from './types.ts';

export type OverflowPolicy =
  /** Discard the subscriber's oldest buffered event. Default. */
  | 'drop-oldest'
  /** Discard the incoming event for that subscriber. */
  | 'drop-newest'
  /** Close that subscriber's stream. */
  | 'close-subscriber';

export interface EventHubOptions {
  /** Retained "recent" window used for opt-in late-subscriber replay. */
  recentCapacity?: number;
  overflow?: OverflowPolicy;
  /** Per-subscriber buffer default. */
  defaultBuffer?: number;
}

export interface HubStats {
  readonly published: number;
  readonly subscribers: number;
  /** Retained events available to a replaying late subscriber. */
  readonly retained: number;
  /** Total events dropped across all subscribers. */
  readonly droppedTotal: number;
}

const DEFAULT_RECENT = 256;
const DEFAULT_BUFFER = 1024;

/** Fixed-capacity FIFO that drops from the front. */
class Ring<T> {
  private items: T[] = [];
  private dropped = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.cap) {
      this.items.shift();
      this.dropped++;
    }
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  drain(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }
}

/** A live, independently-buffered view of a hub. */
export interface HubSubscription<T> extends AsyncIterable<T> {
  readonly id: number;
  /** Events discarded for this subscriber because it could not keep up. */
  readonly droppedCount: () => number;
  /** Stop receiving events and release the buffer immediately. */
  close: () => void;
}

class SubscriptionImpl<T> implements HubSubscription<T> {
  readonly id: number;
  private readonly buffer: Ring<T>;
  private readonly hub: EventHub<T>;
  private readonly cap: number;
  private readonly policy: OverflowPolicy;
  private waiter: (() => void) | null = null;
  private done: boolean;
  private overflowed = false;

  constructor(
    id: number,
    hub: EventHub<T>,
    cap: number,
    policy: OverflowPolicy,
    initial: readonly T[],
    startDone = false,
  ) {
    this.id = id;
    this.hub = hub;
    this.cap = cap;
    this.policy = policy;
    this.done = startDone;
    this.buffer = new Ring<T>(cap);
    for (const ev of initial) this.buffer.push(ev);
  }

  droppedCount(): number {
    return this.buffer.droppedCount;
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.hub.remove(this);
    this.wake();
  }

  /** Called by the hub. Must never block. */
  accept(ev: T): void {
    if (this.done) return;
    if (this.buffer.size >= this.cap) {
      this.overflowed = true;
      switch (this.policy) {
        case 'drop-oldest':
          // Ring.push evicts the front to make room for the new event.
          this.buffer.push(ev);
          break;
        case 'drop-newest':
          // The incoming event is the one discarded; the subscriber keeps the
          // older, more relevant context.
          break;
        case 'close-subscriber':
          this.close();
          return;
      }
    } else {
      this.buffer.push(ev);
    }
    this.wake();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.hub.remove(this);
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
    }
  }

  /** Exposed for tests/diagnostics. */
  get isOverflowed(): boolean {
    return this.overflowed;
  }
}

export class EventHub<T> {
  private readonly subs = new Set<SubscriptionImpl<T>>();
  private readonly recent: Ring<T>;
  private nextId = 1;
  private publishedCount = 0;
  private droppedTotal = 0;
  private closedFlag = false;

  private readonly recentCapacity: number;
  private readonly overflow: OverflowPolicy;
  private readonly defaultBuffer: number;

  constructor(options: EventHubOptions = {}) {
    this.recentCapacity = options.recentCapacity ?? DEFAULT_RECENT;
    this.overflow = options.overflow ?? 'drop-oldest';
    this.defaultBuffer = options.defaultBuffer ?? DEFAULT_BUFFER;
    this.recent = new Ring<T>(this.recentCapacity);
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  stats(): HubStats {
    return {
      published: this.publishedCount,
      subscribers: this.subs.size,
      retained: this.recent.size,
      droppedTotal: this.droppedTotal,
    };
  }

  /**
   * Late-subscriber semantics are explicit: nothing by default, or the
   * retained recent window when `replay: 'replay'`.
   */
  subscribe(opts: SubscribeOptions = {}): HubSubscription<T> {
    if (this.closedFlag) {
      // Post-terminal subscription: already complete. It yields nothing and
      // terminates immediately rather than hanging on a closed hub.
      return new SubscriptionImpl<T>(this.nextId++, this, 1, 'close-subscriber', [], true);
    }
    const cap = Math.max(1, opts.buffer ?? this.defaultBuffer);
    const initial = opts.replay === 'replay' ? this.recent.drain() : [];
    const sub = new SubscriptionImpl<T>(this.nextId++, this, cap, this.overflow, initial);
    this.subs.add(sub);
    return sub;
  }

  publish(ev: T): void {
    if (this.closedFlag) return;
    this.publishedCount++;
    this.recent.push(ev);
    // Snapshot: a subscriber that closes during iteration must not mutate the
    // set we are walking.
    for (const sub of [...this.subs]) {
      const before = sub.droppedCount();
      sub.accept(ev);
      if (sub.droppedCount() > before) this.droppedTotal++;
    }
  }

  /** Complete every subscriber and free all buffers. Idempotent. */
  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    for (const sub of [...this.subs]) sub.finish();
    this.subs.clear();
    this.recent.drain();
  }

  remove(sub: SubscriptionImpl<T>): void {
    this.subs.delete(sub);
  }
}
