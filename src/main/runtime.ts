// Layer composition: everything the main process runs, in dependency order.
import { Effect, Layer, ManagedRuntime } from 'effect'
import type { AppState } from '@shared/types'

/** AppState as the background service knows it. */
export type ServiceSnapshot = Omit<AppState, 'dataDir' | 'agentDir' | 'windowButtons' | 'service' | 'update' | 'voice'>
import { AgentdLive } from './services/Agentd'
import { AppConnector, AppConnectorLive } from './services/AppConnector'
import { ConfigLive, type ConfigShape } from './services/Config'
import { Connectors, ConnectorsLive } from './services/Connectors'
import { DataLive } from './services/Data'
import { Drafts, DraftsLive } from './services/Drafts'
import { Engine } from './services/Engine'
import { Events, EventsLive } from './services/Events'
import { Hub, HubLive } from './services/Hub'
import { Marketplace, MarketplaceLive } from './services/Marketplace'
import { Notifications, NotificationsLive } from './services/Notifications'
import { Settings, SettingsLive } from './services/Settings'
import { Tools, ToolsLive } from './services/Tools'
import { Workspaces, WorkspacesLive } from './services/Workspaces'

export const makeRuntime = (config: ConfigShape) => {
  const base = Layer.mergeAll(ConfigLive(config), EventsLive).pipe((l) => DataLive.pipe(Layer.provideMerge(l)))
  const settings = SettingsLive.pipe(Layer.provideMerge(base))
  const engine = AgentdLive.pipe(Layer.provideMerge(settings))
  const stores = Layer.mergeAll(ConnectorsLive, WorkspacesLive).pipe(Layer.provideMerge(engine))
  const services = Layer.mergeAll(ToolsLive, NotificationsLive, DraftsLive).pipe(Layer.provideMerge(stores))
  // Forking an item can install the custom tools it ships with.
  const marketplace = MarketplaceLive.pipe(Layer.provideMerge(services))
  const top = Layer.mergeAll(AppConnectorLive, HubLive).pipe(Layer.provideMerge(marketplace))
  return ManagedRuntime.make(top)
}

export const snapshot = Effect.gen(function* () {
  const engine = yield* Engine
  const connectors = yield* Connectors
  const workspaces = yield* Workspaces
  const marketplace = yield* Marketplace
  const tools = yield* Tools
  const notifications = yield* Notifications
  const settings = yield* Settings
  // What the window adds (its folders, its buttons, how it reaches this service) it adds itself.
  const state: ServiceSnapshot = { engine: engine.state(), connectors: connectors.list(), workspaces: workspaces.list(), marketplace: marketplace.list(), remote: marketplace.remote(), tools: tools.list(), schedules: tools.schedules(), notifications: notifications.list({ limit: 200 }), settings: settings.get(), toolsDir: tools.dir }
  return state
})

export { AppConnector, Connectors, Drafts, Engine, Events, Hub, Marketplace, Notifications, Settings, Tools, Workspaces }
