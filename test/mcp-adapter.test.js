import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleMcpMessage } from '../mcp/stdio.js'

const baseUrl = 'http://127.0.0.1:52730/echo-notes/api'

function response(status, payload) {
  return { status, ok: status >= 200 && status < 300, json: async () => payload }
}

test('MCP initialize negotiates a supported protocol version', async () => {
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } },
  }, { baseUrl })
  assert.equal(result.result.protocolVersion, '2025-03-26')
  assert.equal(result.result.serverInfo.name, 'echo-notes')
  assert.ok(result.result.capabilities.tools)
})

test('MCP rejects unsupported protocol versions and ignores notifications', async () => {
  const unsupported = await handleMcpMessage({
    jsonrpc: '2.0', id: 9, method: 'initialize',
    params: { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'other', version: '1' } },
  }, { baseUrl })
  assert.equal(unsupported.error.code, -32602)
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { baseUrl }), undefined)
  assert.deepEqual(await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'ping' }, { baseUrl }), { jsonrpc: '2.0', id: 10, result: {} })
})

test('legacy MCP clients receive only fields defined in their protocol version', async () => {
  const options = { baseUrl }
  await handleMcpMessage({
    jsonrpc: '2.0', id: 20, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
  }, options)
  const listed = await handleMcpMessage({ jsonrpc: '2.0', id: 21, method: 'tools/list' }, options)
  assert.equal(Object.hasOwn(listed.result.tools[0], 'outputSchema'), false)
  const called = await handleMcpMessage({
    jsonrpc: '2.0', id: 22, method: 'tools/call', params: { name: 'echo_note', arguments: { action: 'status' } },
  }, { ...options, fetchImpl: async () => response(200, { ok: true, value: { ok: true } }) })
  assert.equal(Object.hasOwn(called.result, 'structuredContent'), false)
})

test('MCP tools/list exposes the portable Echo Notes JSON Schema', async () => {
  const result = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { baseUrl })
  const tool = result.result.tools.find((item) => item.name === 'echo_note')
  assert.ok(tool)
  assert.equal(tool.inputSchema.type, 'object')
  assert.deepEqual(tool.inputSchema.required, ['action'])
  assert.ok(tool.inputSchema.properties.action.enum.includes('write'))
  assert.ok(!JSON.stringify(tool.inputSchema).includes('"type":"json"'))
})

test('MCP tools/call forwards the action to the shared Harness tool endpoint', async () => {
  let called
  const fetchImpl = async (url, init) => {
    called = { url, init }
    return response(200, { ok: true, value: { ok: true, unlocked: true, noteCount: 3 } })
  }
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo_note', arguments: { action: 'status' } },
  }, { baseUrl, fetchImpl })
  assert.equal(called.url, `${baseUrl}/tool`)
  assert.equal(called.init.method, 'POST')
  assert.deepEqual(JSON.parse(called.init.body), { action: 'status' })
  assert.equal(result.result.isError, false)
  assert.match(result.result.content[0].text, /noteCount/)
  assert.deepEqual(result.result.structuredContent, { ok: true, unlocked: true, noteCount: 3 })
})

test('MCP tools/call returns a structured error for locked vault responses', async () => {
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'echo_note', arguments: { action: 'read', id: 'n1' } },
  }, {
    baseUrl,
    fetchImpl: async () => response(200, { ok: true, value: { ok: false, error: 'locked', message: 'Unlock the vault in Echo Notes.' } }),
  })
  assert.equal(result.result.isError, true)
  assert.match(result.result.content[0].text, /Unlock the vault/)
})

test('MCP rejects unknown tools, invalid arguments and unknown methods', async () => {
  const unknownTool = await handleMcpMessage({
    jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'other', arguments: {} },
  }, { baseUrl })
  assert.equal(unknownTool.result.isError, true)

  const badArgs = await handleMcpMessage({
    jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'echo_note', arguments: { action: 'bogus' } },
  }, { baseUrl })
  assert.equal(badArgs.result.isError, true)

  const unknownMethod = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'bogus' }, { baseUrl })
  assert.equal(unknownMethod.error.code, -32601)
})

test('MCP surfaces unreachable Harness endpoints as an actionable tool error', async () => {
  const result = await handleMcpMessage({
    jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'echo_note', arguments: { action: 'status' } },
  }, { baseUrl, fetchImpl: async () => { throw new Error('connection refused') } })
  assert.equal(result.result.isError, true)
  assert.match(result.result.content[0].text, /connection refused/)
})
