#!/usr/bin/env node
/** Minimal MCP stdio adapter for the Echo Notes Harness endpoint. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { ECHO_NOTE_DESCRIPTION, ECHO_NOTE_OUTPUT_SCHEMA, ECHO_NOTE_PARAMETERS, validateEchoNoteArgs } from '../src/agent-contract.js'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-06-18', '2025-03-26'])
export const MCP_TOOL = Object.freeze({
  name: 'echo_note',
  description: ECHO_NOTE_DESCRIPTION,
  inputSchema: ECHO_NOTE_PARAMETERS,
  outputSchema: ECHO_NOTE_OUTPUT_SCHEMA,
})

export async function handleMcpMessage(message, options = {}) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return jsonRpcError(message?.id ?? null, -32600, 'Invalid JSON-RPC request')
  }
  const id = message.id
  const params = message.params ?? {}
  switch (message.method) {
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_PROTOCOL_VERSION
      if (!SUPPORTED_PROTOCOL_VERSIONS.has(requested)) return jsonRpcError(id, -32602, `Unsupported MCP protocol version: ${requested}`)
      const protocolVersion = requested
      options.protocolVersion = protocolVersion
      return { jsonrpc: '2.0', id, result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-notes', version: '0.1.0' },
        instructions: 'Echo Notes uses the running DeepSeek Harness vault. The user must unlock the vault in the Harness panel; never request a passphrase as a tool argument.',
      } }
    }
    case 'notifications/initialized':
    case 'ping':
      return id === undefined ? undefined : { jsonrpc: '2.0', id, result: {} }
    case 'tools/list': {
      const tool = options.protocolVersion === '2025-03-26'
        ? { name: MCP_TOOL.name, description: MCP_TOOL.description, inputSchema: MCP_TOOL.inputSchema }
        : MCP_TOOL
      return { jsonrpc: '2.0', id, result: { tools: [tool] } }
    }
    case 'tools/call':
      return callTool(id, params, options)
    default:
      return jsonRpcError(id ?? null, -32601, `Method not found: ${message.method}`)
  }
}

async function callTool(id, params, options) {
  if (params.name !== MCP_TOOL.name) {
    return toolError(id, `Unknown tool: ${String(params.name ?? '')}`)
  }
  try {
    const args = validateEchoNoteArgs(params.arguments ?? {})
    const baseUrl = options.baseUrl ?? process.env.ECHO_NOTES_API_URL
    if (!baseUrl) throw new Error('Set ECHO_NOTES_API_URL to the running Harness Echo Notes API base URL.')
    const fetchImpl = options.fetchImpl ?? globalThis.fetch
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
      signal: options.signal,
    })
    const payload = await response.json()
    if (!response.ok || payload?.ok !== true) {
      const message = payload?.message ?? `Harness returned HTTP ${response.status}`
      return toolError(id, message)
    }
    const value = payload.value
    const result = {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      isError: value?.ok === false,
    }
    if (options.protocolVersion !== '2025-03-26') result.structuredContent = value
    return { jsonrpc: '2.0', id, result }
  } catch (error) {
    return toolError(id, error instanceof Error ? error.message : String(error))
  }
}

function toolError(id, message) {
  return {
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text: message }], isError: true },
  }
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/** Read newline-delimited JSON-RPC over stdin and write one response per request. */
export async function runStdio({ input = process.stdin, output = process.stdout, options = {} } = {}) {
  let buffer = ''
  for await (const chunk of input) {
    buffer += chunk.toString('utf8')
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        output.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))}\n`)
        continue
      }
      const response = await handleMcpMessage(message, options)
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`)
    }
  }
  if (buffer.trim()) {
    try {
      const response = await handleMcpMessage(JSON.parse(buffer), options)
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`)
    } catch {
      output.write(`${JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))}\n`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStdio().catch((error) => {
    process.stderr.write(`echo-notes MCP adapter: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
