/**
 * Types for the shell's INC seam.
 *
 * `@napplet/sdk` exports the domain objects but not the types behind them, so these are derived
 * from `inc.on` rather than pulling `@napplet/core` into every napplet. Both shapes changed in
 * SDK 0.27 and neither change is visible to `tsc` when the call site lives in a `.svelte` file,
 * so naming them here gives the compiler something to check against.
 */
import { inc } from '@napplet/sdk';

/**
 * Handle returned by `inc.on` and `identity.onChanged`. Released with `close()` — there is no
 * `unsubscribe()`, and calling one throws at unmount rather than at build time.
 */
export type Subscription = ReturnType<typeof inc.on>;

/**
 * One delivered INC event: `{ topic, sender, payload? }`. Subscribers receive this envelope, never
 * the bare payload — read `event.payload` to get what the emitter sent.
 */
export type IncEvent = Parameters<Parameters<typeof inc.on>[1]>[0];
