import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexBin } from './codex-bin'
import type { BrowserSignIn } from './types'

// Codex signs in to ChatGPT through its app-server: account/login/start gives the address to open,
// Codex itself takes the browser's answer on 127.0.0.1:1455, and account/login/completed says how
// it went. Nothing is typed in a terminal. Protocol verified against codex-cli 0.161.0.
export function codexSignIn(): Promise<BrowserSignIn> {
  const child = spawn(codexBin(), ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n')
  let loginId: string | undefined
  let ended = false
  const end = () => {
    ended = true
    setTimeout(() => child.kill('SIGTERM'), 1000).unref()
  }
  let finish!: (error?: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    finish = (error) => {
      if (ended) return
      end()
      error ? reject(error) : resolve()
    }
  })
  done.catch(() => {})
  return new Promise<BrowserSignIn>((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Codex did not start its sign-in')), 15000)
    const fail = (error: Error) => {
      clearTimeout(timer)
      reject(error)
      finish(error)
    }
    child.on('error', fail)
    child.stdin.on('error', () => {})
    child.on('exit', () => fail(new Error('Codex stopped before the sign-in finished')))
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      if (message.id === 1) {
        send({ method: 'initialized', params: {} })
        send({ id: 2, method: 'account/login/start', params: { type: 'chatgpt' } })
      } else if (message.id === 2) {
        clearTimeout(timer)
        const url = message.result?.authUrl
        if (message.error || typeof url !== 'string') return fail(new Error(message.error?.message ?? 'Codex gave no address to sign in at'))
        loginId = message.result.loginId
        resolve({
          url,
          done,
          cancel: () => {
            if (loginId && !ended) send({ id: 3, method: 'account/login/cancel', params: { loginId } })
            finish(new Error('Cancelled'))
          },
        })
      } else if (message.method === 'account/login/completed' && (!loginId || message.params?.loginId === loginId)) {
        finish(message.params?.success ? undefined : new Error(message.params?.error ?? 'The sign-in did not finish'))
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'lynx', title: 'Lynx', version: '0.1.0' } } })
  })
}
