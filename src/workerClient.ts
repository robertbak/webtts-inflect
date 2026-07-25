import { Effect, Queue, Stream } from 'effect'
import { ManagedResource } from 'foldkit'

export const SynthesisWorker = ManagedResource.tag<Worker>()('SynthesisWorker')
export type SynthesisWorkerService = ManagedResource.ServiceOf<typeof SynthesisWorker>

export const acquireSynthesisWorker = Effect.sync(
  () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
)

export const releaseSynthesisWorker = (worker: Worker): Effect.Effect<void> =>
  Effect.sync(() => {
    worker.terminate()
  })

interface WorkerResultMessage {
  readonly type: 'result'
  readonly id: string
  readonly synthMs: number
  readonly samples: Float32Array
  readonly sampleRate: number
  readonly normalizedText: string
  readonly phonemeText: string
}
interface WorkerPreloadedMessage {
  readonly type: 'preloaded'
  readonly id: string
  readonly modelKey: string
}
interface WorkerErrorMessage {
  readonly type: 'error'
  readonly id: string
  readonly message: string
}
type WorkerResponse = WorkerResultMessage | WorkerPreloadedMessage | WorkerErrorMessage

export interface WorkerProgressMessage {
  readonly type: 'progress'
  readonly modelKey: string
  readonly fraction: number
  readonly phase: 'downloading' | 'compiling'
}

/**
 * Streams every 'progress' message the worker broadcasts (download
 * progress for whichever model it's currently loading), independent of
 * any single request/response -- unlike requestFromWorker, these aren't
 * correlated to one call's id, since a single preload/synthesize request
 * can produce many progress updates before its one final response.
 */
export const streamWorkerProgress = (worker: Worker): Stream.Stream<WorkerProgressMessage> =>
  Stream.callback<WorkerProgressMessage>(queue =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const handler = (event: MessageEvent<WorkerProgressMessage | WorkerResponse>) => {
          if (event.data.type === 'progress') {
            Queue.offerUnsafe(queue, event.data)
          }
        }
        worker.addEventListener('message', handler)
        return handler
      }),
      handler =>
        Effect.sync(() => {
          worker.removeEventListener('message', handler)
        }),
    ).pipe(Effect.flatMap(() => Effect.never)),
  )

/**
 * Sends one request to the worker and waits for the matching response by
 * id, mirroring the vanilla-JS requestChunk()/postMessage-onmessage
 * correlation pattern. One request per call; the worker itself serializes
 * handling internally, so overlapping calls are safe to issue concurrently
 * from here.
 */
export const requestFromWorker = (
  worker: Worker,
  payload: Record<string, unknown>,
): Effect.Effect<WorkerResponse, Error> =>
  Effect.callback<WorkerResponse, Error>(resume => {
    // crypto.randomUUID() requires a secure context (https or localhost),
    // unavailable when testing over plain HTTP on a LAN IP (e.g. from a
    // phone), so this avoids it rather than just working sometimes.
    const id = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

    const handleMessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) {
        return
      }
      worker.removeEventListener('message', handleMessage)
      if (event.data.type === 'error') {
        resume(Effect.fail(new Error(event.data.message)))
      } else {
        resume(Effect.succeed(event.data))
      }
    }

    worker.addEventListener('message', handleMessage)
    worker.postMessage({ ...payload, id })

    return Effect.sync(() => {
      worker.removeEventListener('message', handleMessage)
    })
  })
