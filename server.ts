#!/usr/bin/env bun
/**
 * Voice channel for Claude Code.
 *
 * Dual-interface MCP server: stdio for Claude Code communication,
 * HTTP for the orchestrator. Bridges synchronous HTTP request-response
 * to async MCP channel notifications via a pending promise map.
 *
 * Modeled on the Telegram channel plugin pattern.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { randomBytes } from 'crypto'

// --- Configuration ---
const HTTP_PORT = parseInt(process.env.VOICE_CHANNEL_PORT ?? '9000', 10)
const REQUEST_TIMEOUT_MS = parseInt(process.env.VOICE_CHANNEL_TIMEOUT ?? '120000', 10)

// --- Pending request bridge ---
// Maps request_id -> { resolve, reject, timer } for correlating
// HTTP requests with MCP voice_reply tool calls.
type PendingRequest = {
  resolve: (text: string) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}
const pending = new Map<string, PendingRequest>()

// --- MCP Server (stdio, facing Claude Code) ---
const mcp = new Server(
  { name: 'voice-channel', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'Messages from the voice channel arrive as <channel source="voice" request_id="..." user="..." ts="..." detail_level="..." type="...">.',
      'You MUST call voice_reply with the matching request_id for every message you receive.',
      '',
      '## Message types',
      '',
      '### type="voice" (default)',
      'The sender is using voice input (speech-to-text). They cannot see your transcript output.',
      'The response will be converted to speech (TTS) and played back to the user.',
      'Keep responses concise and natural for spoken delivery.',
      'Avoid code blocks, URLs, and markdown formatting in voice replies.',
      'If the task involves complex output, give a spoken summary.',
      '',
      '### type="narrate"',
      'The TTS-service is requesting narration of markdown content for audio playback.',
      'You MUST reply with a JSON array of section narrations:',
      '  [{"section_id": "s0", "narration": "..."}, {"section_id": "s1", "narration": "..."}, ...]',
      'Each section_id is "s" followed by its zero-based index.',
      'Convert markdown structure into natural, flowing spoken prose.',
      'Omit raw URLs, code blocks, and formatting artifacts.',
      'Use transition phrases between sections for a smooth listening experience.',
      '',
      '## Detail levels (detail_level in meta)',
      '',
      'detail_level="overview": Brief summary. Cover only the key takeaways — roughly 20-30% of the source length.',
      'detail_level="standard" (default): Balanced narration. Hit the main points with enough context — roughly 40-50% of the source length.',
      'detail_level="detailed": Thorough narration. Preserve most information and nuance — roughly 60-70% of the source length.',
      '',
      '## Speech rules (apply to both types)',
      'Write for the ear, not the eye. Use short sentences and plain language.',
      'Never emit raw URLs — describe the link instead ("the GitHub repo", "the docs page").',
      'Spell out uncommon abbreviations on first use.',
      'Avoid parenthetical asides; restructure into separate sentences.',
    ].join('\n'),
  },
)

// Crash safety — keep serving even on unhandled rejections.
process.on('unhandledRejection', err => {
  process.stderr.write(`voice-channel: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`voice-channel: uncaught exception: ${err}\n`)
})

// --- Tool: voice_reply ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'voice_reply',
      description:
        'Send a response back to the voice caller. You MUST call this for every voice message you receive. ' +
        'The text will be converted to speech (TTS) and played back. Keep responses concise and natural for spoken delivery.',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: {
            type: 'string',
            description: 'The request_id from the inbound voice message. Must match exactly.',
          },
          text: {
            type: 'string',
            description: 'Your response text. Will be spoken via TTS. Keep it natural and concise.',
          },
        },
        required: ['request_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'voice_reply') {
    return {
      content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }],
      isError: true,
    }
  }

  const { request_id, text } = req.params.arguments as {
    request_id: string
    text: string
  }

  const entry = pending.get(request_id)
  if (!entry) {
    return {
      content: [
        {
          type: 'text',
          text: `No pending voice request with id "${request_id}". It may have timed out.`,
        },
      ],
      isError: true,
    }
  }

  clearTimeout(entry.timer)
  pending.delete(request_id)
  entry.resolve(text)

  return {
    content: [{ type: 'text', text: `Voice reply sent (${request_id})` }],
  }
})

// --- Connect MCP via stdio ---
await mcp.connect(new StdioServerTransport())

// --- HTTP Server (facing orchestrator) ---
const httpServer = Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // Health check
    if (url.pathname === '/health' && req.method === 'GET') {
      return Response.json({
        status: 'ok',
        pending_requests: pending.size,
      })
    }

    // Voice request endpoint
    if (url.pathname === '/voice' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          text: string
          user_id?: string
          detail_level?: string  // "overview" | "standard" | "detailed"
          type?: string          // "voice" | "narrate"
        }

        if (!body.text || typeof body.text !== 'string') {
          return Response.json(
            { error: 'Missing or invalid "text" field' },
            { status: 400 },
          )
        }

        const request_id = randomBytes(8).toString('hex')

        // Create pending request and await Claude's voice_reply
        const responseText = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(request_id)
            reject(
              new Error(
                `Voice request timed out after ${REQUEST_TIMEOUT_MS}ms`,
              ),
            )
          }, REQUEST_TIMEOUT_MS)

          pending.set(request_id, { resolve, reject, timer })

          // Push notification into Claude Code session
          mcp
            .notification({
              method: 'notifications/claude/channel',
              params: {
                content: body.text,
                meta: {
                  request_id,
                  user: body.user_id ?? 'voice-user',
                  ts: new Date().toISOString(),
                  detail_level: body.detail_level ?? 'standard',
                  type: body.type ?? 'voice',
                },
              },
            })
            .catch(err => {
              clearTimeout(timer)
              pending.delete(request_id)
              reject(
                new Error(`Failed to deliver to Claude: ${err}`),
              )
            })
        })

        return Response.json({ response: responseText, request_id })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const status = msg.includes('timed out') ? 504 : 500
        return Response.json({ error: msg }, { status })
      }
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  },
})

process.stderr.write(
  `voice-channel: HTTP server listening on port ${HTTP_PORT}\n`,
)

// --- Graceful shutdown ---
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('voice-channel: shutting down\n')

  // Reject all pending requests so orchestrator gets errors instead of hanging
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error('Voice channel shutting down'))
    pending.delete(id)
  }

  httpServer.stop()
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
