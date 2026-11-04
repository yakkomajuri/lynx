// A read-only security review of a marketplace template. The user chooses an agent and model;
// its assessment opens in the agent panel.
// What it looks for is the two things that matter when forking someone else's code: ways for your data
// to get out, and anything that runs on this computer or keeps running behind your back.
import { useState } from 'react'
import { chooseModel, effortName, harnessName, useProviders } from '@kit/agents'
import type { MarketplaceItem } from '@shared/types'
import { Shell } from './Connectors'

import type { ReviewChoice } from '@shared/templateReview'
export { reviewOf, type ReviewChoice, type ReviewStart } from '@shared/templateReview'

const SAVED = 'sb.review.choice'

/** An agent, model and effort to run something with, remembered under `key` for next time. */
export function useAgentChoice(key: string) {
  const { providers, loading } = useProviders()
  const [saved, setSaved] = useState<Partial<ReviewChoice>>(() => JSON.parse(localStorage.getItem(key) ?? '{}'))
  const harness = providers.find((p) => p.name === saved.harness)?.name ?? providers[0]?.name
  const { model, effort, models, efforts } = chooseModel(providers.find((p) => p.name === harness), harness === saved.harness ? saved : {})
  const set = (next: Partial<ReviewChoice>) => setSaved((s) => ({ ...s, ...next }))
  /** What was picked, kept for next time; undefined while there is no agent to pick. */
  const pick = (extra: Partial<ReviewChoice> = {}): ReviewChoice | undefined => {
    if (!harness) return undefined
    const choice: ReviewChoice = { harness, model, effort, access: saved.access ?? 'read', ...extra }
    localStorage.setItem(key, JSON.stringify(choice))
    return choice
  }
  return { providers, loading, harness, model, effort, models, efforts, saved, set, pick }
}

/** The agent, model and effort fields, or why there is no agent to pick. */
export function AgentFields({ choice }: { choice: ReturnType<typeof useAgentChoice> }) {
  const { providers, loading, harness, model, effort, models, efforts, set } = choice
  if (!harness) return <div className="sb-error">{loading ? 'Looking for agents on this machine…' : 'No agent is available on this machine. Install Claude Code or Codex.'}</div>
  return (
    <>
      <label className="sb-field">
        <span>Agent</span>
        <select className="sb-input" value={harness} onChange={(e) => set({ harness: e.target.value, model: undefined, effort: undefined })}>
          {providers.map((p) => (
            <option key={p.name} value={p.name}>
              {harnessName(p.name)}
            </option>
          ))}
        </select>
      </label>
      {models.length > 0 && (
        <label className="sb-field">
          <span>Model</span>
          <select className="sb-input" value={model} onChange={(e) => set({ harness, model: e.target.value, effort: undefined })}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {efforts.length > 0 && (
        <label className="sb-field">
          <span>Effort</span>
          <select className="sb-input" value={effort} onChange={(e) => set({ harness, model, effort: e.target.value })}>
            {efforts.map((e) => (
              <option key={e} value={e}>
                {effortName(e)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  )
}

export function ReviewDialog({ item, onClose, onStart }: { item: MarketplaceItem; onClose: () => void; onStart: (choice: ReviewChoice) => void }) {
  const choice = useAgentChoice(SAVED)
  const start = () => {
    const picked = choice.pick({ access: 'read' })
    if (picked) onStart(picked)
  }
  return (
    <Shell
      title="Security review"
      onClose={onClose}
      width={480}
      footer={
        <>
          <button className="sb-btn" onClick={onClose}>Cancel</button>
          <button className="sb-btn primary" disabled={!choice.harness} onClick={start}>
            Start review
          </button>
        </>
      }
    >
      <p className="h-review-lead">
        An agent will check <strong>{item.name}</strong> before you create a workspace. Read-only, with no connector access.
      </p>
      <div className="h-review-agent"><AgentFields choice={choice} /></div>
    </Shell>
  )
}
