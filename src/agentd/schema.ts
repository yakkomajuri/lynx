// The JSON Schema subset the tools advertise, and a checker for it, so what is listed is what is enforced.
import { problem } from './store'

export type JsonSchema = {
  type?: 'object' | 'string' | 'integer' | 'boolean' | 'array'
  description?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  enum?: unknown[]
  minLength?: number
  maxItems?: number
  minimum?: number
  maximum?: number
  pattern?: string
  format?: string
  anyOf?: JsonSchema[]
  default?: unknown
}

export const uuid: JsonSchema = { type: 'string', format: 'uuid', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' }
export const text: JsonSchema = { type: 'string', minLength: 1 }
export const str: JsonSchema = { type: 'string' }
export const bool: JsonSchema = { type: 'boolean' }
export const int = (minimum?: number, maximum?: number): JsonSchema => ({ type: 'integer', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) })
export const limit = int(1, 500)
export const cursor: JsonSchema = { type: 'string', pattern: '^[0-9]+$' }
export const timestamp: JsonSchema = { type: 'string', format: 'date-time' }
export const strings: JsonSchema = { type: 'object', additionalProperties: { type: 'string' } }
export const anyObject: JsonSchema = { type: 'object', additionalProperties: true }
export const literals = (...values: string[]): JsonSchema => ({ type: 'string', enum: values })
export const array = (items: JsonSchema, maxItems?: number): JsonSchema => ({ type: 'array', items, ...(maxItems ? { maxItems } : {}) })
/** An object; keys named in `required` must be present, others are optional. Unknown keys are refused. */
export const object = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false })

function fail(path: string, message: string): never {
  throw problem('invalid_request', `${path || 'input'} ${message}`)
}

export function check(schema: JsonSchema, value: unknown, path = ''): void {
  if (schema.anyOf) {
    const errors: string[] = []
    for (const option of schema.anyOf) {
      try {
        return check(option, value, path)
      } catch (e) {
        errors.push((e as Error).message)
      }
    }
    fail(path, `matches none of the allowed shapes (${errors.join('; ')})`)
  }
  if (schema.enum && !schema.enum.includes(value)) fail(path, `must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`)
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') fail(path, 'must be a string')
      if (schema.minLength && value.length < schema.minLength) fail(path, 'must not be empty')
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(path, schema.format ? `must be a ${schema.format}` : 'has the wrong format')
      if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) fail(path, 'must be a date and time, e.g. "2026-10-11T09:30:00Z"')
      return
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer')
      if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be at least ${schema.minimum}`)
      if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be at most ${schema.maximum}`)
      return
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'must be true or false')
      return
    case 'array':
      if (!Array.isArray(value)) fail(path, 'must be an array')
      if (schema.maxItems && value.length > schema.maxItems) fail(path, `takes at most ${schema.maxItems} items`)
      if (schema.items) value.forEach((item, i) => check(schema.items!, item, `${path}[${i}]`))
      return
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) if (record[key] === undefined) fail(path ? `${path}.${key}` : key, 'is required')
      for (const [key, item] of Object.entries(record)) {
        if (item === undefined) continue
        const at = path ? `${path}.${key}` : key
        const property = schema.properties?.[key]
        if (property) check(property, item, at)
        else if (schema.additionalProperties === false) fail(at, 'is not a known field')
        else if (typeof schema.additionalProperties === 'object') check(schema.additionalProperties, item, at)
      }
      return
    }
  }
}
