// MCP-UI: a connector can return a ready-made interactive view as an embedded `ui://` resource.
// This renders one in a sandboxed frame and answers its messages: tool calls go back to the same
// connector, prompts go to the agent panel, links open in the browser. Both dialects are spoken:
// mcp-ui's action messages ({ type: 'tool' | 'prompt' | 'link' | 'notify' | 'intent' }) and the
// JSON-RPC used by MCP Apps (ui/initialize, tools/call, ui/open-link, ui/message).
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { askAgent, call, openExternal, toast, useTool } from './core'
import { Empty, ErrorNote, Spinner } from './ui'

export interface UIResource {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

/** Find the first `ui://` resource in what a tool returned. */
export function findUIResource(result: any): UIResource | null {
  const content: any[] = Array.isArray(result?.content) ? result.content : Array.isArray(result) ? result : []
  for (const c of content) {
    const r = c?.type === 'resource' ? c.resource : c
    if (r && typeof r.uri === 'string' && r.uri.startsWith('ui://')) return r
  }
  return result?.uri?.startsWith?.('ui://') ? result : null
}

const decode = (r: UIResource) => r.text ?? (r.blob ? new TextDecoder().decode(Uint8Array.from(atob(r.blob), (c) => c.charCodeAt(0))) : '')

export function McpUI(props: { connector: string; tool?: string; args?: Record<string, unknown>; resource?: UIResource; height?: number; style?: CSSProperties }) {
  const q = useTool(props.connector, props.tool ?? '', props.args ?? {}, { enabled: !props.resource && !!props.tool, staleMs: 30000 })
  const resource = props.resource ?? (q.data ? findUIResource(q.data) : null)
  if (!props.resource && q.loading)
    return (
      <Empty>
        <Spinner />
      </Empty>
    )
  if (q.error) return <ErrorNote error={q.error} retry={() => void q.reload()} />
  if (!resource) return <Empty title="No UI in this result">The tool answered without a ui:// resource.</Empty>
  return <ResourceFrame connector={props.connector} resource={resource} input={props.args} result={q.data} height={props.height} style={props.style} />
}

function ResourceFrame({ connector, resource, input, result, height, style }: { connector: string; resource: UIResource; input?: Record<string, unknown>; result?: unknown; height?: number; style?: CSSProperties }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [auto, setAuto] = useState<number>()
  const mime = resource.mimeType ?? 'text/html'
  const body = useMemo(() => decode(resource), [resource])
  const external = mime.startsWith('text/uri-list') ? body.split('\n').find((l) => l.trim() && !l.startsWith('#'))?.trim() : undefined

  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const win = frame.current?.contentWindow
      if (!win || e.source !== win) return
      const m = e.data
      if (!m || typeof m !== 'object') return
      const reply = (msg: unknown) => win.postMessage(msg, '*')
      const runTool = (name: string, args: Record<string, unknown>) => call(connector, name, args ?? {})

      // ── MCP Apps: JSON-RPC over postMessage
      if (m.jsonrpc === '2.0') {
        const answer = (res: unknown) => m.id !== undefined && reply({ jsonrpc: '2.0', id: m.id, result: res })
        const fail = (err: unknown) => m.id !== undefined && reply({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } })
        try {
          if (m.method === 'ui/initialize') answer({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', hostInfo: { name: 'Lynx', version: '0.1.0' }, hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} }, hostContext: { theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', displayMode: 'inline' } })
          else if (m.method === 'ui/notifications/initialized') {
            reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: input ?? {} } })
            if (result !== undefined) reply({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: result })
          } else if (m.method === 'tools/call') {
            const data = await runTool(m.params?.name, m.params?.arguments)
            answer({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }], structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : undefined })
          } else if (m.method === 'ui/open-link') {
            openExternal(String(m.params?.url))
            answer({})
          } else if (m.method === 'ui/message') {
            const text = (m.params?.content ?? []).map?.((c: any) => c.text).join('\n') ?? m.params?.content?.text ?? ''
            askAgent(String(text))
            answer({})
          } else if (m.method === 'ui/notifications/size-changed') {
            if (typeof m.params?.height === 'number') setAuto(m.params.height)
          } else if (m.method === 'ping') answer({})
          else if (m.id !== undefined) reply({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Unsupported: ${m.method}` } })
        } catch (err) {
          fail(err)
        }
        return
      }

      // ── mcp-ui action messages
      const done = (payload: Record<string, unknown>) => m.messageId && reply({ type: 'ui-message-response', messageId: m.messageId, payload })
      if (m.messageId) reply({ type: 'ui-message-received', messageId: m.messageId })
      try {
        if (m.type === 'tool') done({ response: await runTool(m.payload?.toolName, m.payload?.params) })
        else if (m.type === 'prompt') (askAgent(String(m.payload?.prompt ?? '')), done({ response: 'ok' }))
        else if (m.type === 'intent') (askAgent(`${m.payload?.intent}: ${JSON.stringify(m.payload?.params ?? {})}`), done({ response: 'ok' }))
        else if (m.type === 'link') (openExternal(String(m.payload?.url)), done({ response: 'ok' }))
        else if (m.type === 'notify') (toast(String(m.payload?.message ?? '')), done({ response: 'ok' }))
        else if (m.type === 'ui-size-change' && typeof m.payload?.height === 'number') setAuto(m.payload.height)
        else if (m.type === 'ui-lifecycle-iframe-ready') reply({ type: 'ui-lifecycle-iframe-render-data', payload: { renderData: { toolInput: input ?? {}, toolOutput: result, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' } } })
      } catch (err) {
        done({ error: err instanceof Error ? err.message : String(err) })
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [connector, input, result])

  if (!mime.startsWith('text/html') && !external) return <Empty title="Unsupported UI resource">{mime} cannot be rendered here.</Empty>
  const css: CSSProperties = { width: '100%', height: height ?? auto ?? 320, border: '1px solid var(--sb-line)', borderRadius: 'var(--sb-radius)', background: 'var(--sb-surface)', display: 'block', ...style }
  return external ? <iframe ref={frame} title={resource.uri} src={external} sandbox="allow-scripts allow-forms allow-same-origin allow-popups" style={css} /> : <iframe ref={frame} title={resource.uri} srcDoc={body} sandbox="allow-scripts allow-forms" style={css} />
}
