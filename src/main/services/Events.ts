// One fan-out for everything the window should hear about.
import { Context, Effect, Layer } from 'effect'
import type { AppEvent } from '@shared/types'

export interface EventsShape {
  readonly publish: (e: AppEvent) => Effect.Effect<void>
  readonly listen: (f: (e: AppEvent) => void) => () => void
  /** Anything that changes AppState calls this; the runtime wires it to a fresh snapshot. */
  readonly changed: Effect.Effect<void>
  readonly onChanged: (f: () => void) => void
}

export class Events extends Context.Service<Events, EventsShape>()('Events') {}

export const EventsLive = Layer.sync(Events)(() => {
  const listeners = new Set<(e: AppEvent) => void>()
  let changed: () => void = () => {}
  return Events.of({
    publish: (e) => Effect.sync(() => listeners.forEach((l) => l(e))),
    listen: (f) => {
      listeners.add(f)
      return () => listeners.delete(f)
    },
    changed: Effect.sync(() => changed()),
    onChanged: (f) => (changed = f),
  })
})
