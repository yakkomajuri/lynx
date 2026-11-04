/** Local backend capacity. Lowering a limit lets running work finish before admitting more. */
export interface ExecutionSettings {
  agents: number
  shell: number
}

export const DEFAULT_EXECUTION: ExecutionSettings = { agents: 12, shell: 16 }
export const MAX_EXECUTION: ExecutionSettings = { agents: 64, shell: 128 }

export const isExecutionLimit = (key: keyof ExecutionSettings, value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_EXECUTION[key]

/** Invalid file edits or environment overrides fall back independently for each queue. */
export const readExecution = (saved: unknown, fallback: ExecutionSettings = DEFAULT_EXECUTION): ExecutionSettings => {
  const value = saved as Partial<ExecutionSettings> | null
  return {
    agents: isExecutionLimit('agents', value?.agents) ? value.agents : fallback.agents,
    shell: isExecutionLimit('shell', value?.shell) ? value.shell : fallback.shell,
  }
}

export const executionFromEnv = (env: Record<string, string | undefined>): ExecutionSettings => readExecution({
  agents: Number(env.AGENTD_CONCURRENCY),
  shell: Number(env.AGENTD_SHELL_CONCURRENCY),
})
