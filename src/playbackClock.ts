import { Effect, Queue, Stream } from 'effect'

import type { AudioEngineHandle } from './audioEngine'
import { TickedPlayback } from './message'

/**
 * Streams one TickedPlayback message per animation frame, carrying the
 * AudioEngine's AudioContext clock (context.currentTime) -- the same
 * clock chunk scheduling uses for playAtSec/endsAtSec, so word-highlight
 * timing stays consistent with actual playback rather than drifting
 * against wall-clock time.
 */
export const streamPlaybackTicks = (handle: AudioEngineHandle): Stream.Stream<typeof TickedPlayback.Type> =>
  Stream.callback<typeof TickedPlayback.Type>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        let frameId = 0
        const tick = () => {
          Queue.offerUnsafe(queue, TickedPlayback({ currentTimeSec: handle.context.currentTime }))
          frameId = requestAnimationFrame(tick)
        }
        frameId = requestAnimationFrame(tick)
        return frameId
      }),
      frameId =>
        Effect.sync(() => {
          cancelAnimationFrame(frameId)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )
