// Syntax colouring for code shown in the app: custom tool source, code in conversations, and
// anything a workspace passes to <Code language>. A fixed set of languages keeps every workspace
// bundle small; a language outside it is shown as plain text.
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, language] of Object.entries({ bash, css, diff, go, java, javascript, json, markdown, python, ruby, rust, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language)
// Names people write on a code fence that the grammars do not already answer to.
hljs.registerAliases(['shell', 'console', 'terminal'], { languageName: 'bash' })
hljs.registerAliases(['jsonc', 'json5'], { languageName: 'json' })
hljs.registerAliases(['vue', 'svelte'], { languageName: 'xml' })

/**
 * `code` as HTML with a span per token (class names `hljs-keyword`, `hljs-string`, …), or null
 * when the language is not one this knows. The text is escaped, so the result is safe to insert.
 */
export function highlight(code: string, language: string | null | undefined): string | null {
  const name = String(language ?? '').toLowerCase()
  if (!name || !hljs.getLanguage(name)) return null
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  } catch {
    return null
  }
}

export type Fenced = { kind: 'text'; text: string } | { kind: 'code'; language: string; code: string }

// A fence opens on a line that ends with ``` and an optional language, and closes on a line that is
// only ```. Text may come before the opening one on its line ("like this: ```js").
// What follows the language must not start with a character a language name could hold: the two
// parts can then be split in only one way, however long the line is.
const OPEN = /^([^`]*)```([\w+#.-]*)((?:[^\w+#.\-`][^`]*)?)$/
const CLOSE = /^[ \t]*```[ \t]*$/
function scan(text: string): { parts: Fenced[]; open: boolean } {
  const parts: Fenced[] = []
  let prose: string[] = []
  let code: string[] | null = null
  let language = ''
  const flush = () => {
    const joined = prose.join('\n').replace(/^\n+|\n+$/g, '')
    if (joined.trim()) parts.push({ kind: 'text', text: joined })
    prose = []
  }
  for (const line of text.split('\n')) {
    if (code === null) {
      const m = OPEN.exec(line)
      // "```js" names a language; "```const x = 1" is code that starts on the fence's own line.
      const named = !!m && (!m[3]!.trim() || (!!m[2] && !!hljs.getLanguage(m[2].toLowerCase())))
      // Three backticks in the middle of a sentence are not a fence.
      if (!m || (!named && m[1]!.trim())) {
        prose.push(line)
        continue
      }
      if (m[1]!.trim()) prose.push(m[1]!.trimEnd())
      flush()
      language = named ? m[2]! : ''
      code = named ? [] : [`${m[2]}${m[3]}`.trim()]
    } else if (CLOSE.test(line) || /[^`\s][ \t]*```[ \t]*$/.test(line)) {
      // The closing fence, alone on its line or straight after the last line of code.
      const last = line.replace(/```[ \t]*$/, '')
      if (last.trim()) code.push(last.trimEnd())
      parts.push({ kind: 'code', language, code: code.join('\n') })
      code = null
    } else code.push(line)
  }
  if (code !== null) parts.push({ kind: 'code', language, code: code.join('\n') })
  else flush()
  return { parts, open: code !== null }
}

/**
 * A message split into prose and fenced code (```js … ```), for showing what someone typed as
 * they typed it with only the code set apart. Nothing else is read as markdown: a message that
 * starts with # or - stays the text it is. A fence left open runs to the end. Code between three
 * backticks on one line (```like this```) is not a block: it is inline code.
 */
export function splitFences(text: string): Fenced[] {
  const { parts } = scan(text)
  return parts.length ? parts : [{ kind: 'text', text }]
}

/** Whether `text` ends inside a fence that has not been closed: a caret after it is typing code. */
export const inFence = (text: string): boolean => scan(text).open
