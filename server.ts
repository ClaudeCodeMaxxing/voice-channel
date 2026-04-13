#!/usr/bin/env bun
/**
 * Voice channel for Claude Code.
 *
 * Dual-interface MCP server: stdio for Claude Code communication,
 * HTTP for the orchestrator. Uses async submit+poll pattern:
 * POST /voice returns 202 immediately, GET /voice/:id polls for result.
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

// --- Request tracking ---
// Pending: waiting for Claude's voice_reply tool call.
// Completed: Claude has replied; orchestrator can poll for the result.
type PendingRequest = {
  timer: ReturnType<typeof setTimeout>
  submitted_at: number
}
type CompletedRequest = {
  response: string
  elapsed_ms: number
}
const pending = new Map<string, PendingRequest>()
const completed = new Map<string, CompletedRequest>()
const erroredRequests = new Set<string>()

// Auto-purge completed entries after 5 minutes to prevent memory leaks.
const COMPLETED_TTL_MS = 5 * 60 * 1000
function scheduleCompletedCleanup(request_id: string): void {
  setTimeout(() => {
    completed.delete(request_id)
    erroredRequests.delete(request_id)
  }, COMPLETED_TTL_MS)
}

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

  const elapsed_ms = Date.now() - entry.submitted_at
  completed.set(request_id, { response: text, elapsed_ms })
  scheduleCompletedCleanup(request_id)

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

    // Voice request endpoint — async submit, returns 202 immediately
    if (url.pathname === '/voice' && req.method === 'POST') {
      try {
        const body = (await req.json()) as {
          text: string
          user_id?: string
          detail_level?: string  // "overview" | "standard" | "detailed"
          type?: string          // "voice" | "narrate"
          files?: Array<{
            path: string
            filename: string
            mime_type: string
          }>
        }

        if (!body.text || typeof body.text !== 'string') {
          return Response.json(
            { error: 'Missing or invalid "text" field' },
            { status: 400 },
          )
        }

        const request_id = randomBytes(8).toString('hex')
        const submitted_at = Date.now()

        // Set up timeout — moves request to error state
        const timer = setTimeout(() => {
          pending.delete(request_id)
          completed.set(request_id, {
            response: '',
            elapsed_ms: Date.now() - submitted_at,
          })
          // Store as error so poll sees "error" not "pending" forever
          erroredRequests.add(request_id)
          scheduleCompletedCleanup(request_id)
        }, REQUEST_TIMEOUT_MS)

        pending.set(request_id, { timer, submitted_at })

        // Build notification content — enrich with file metadata when present
        let content: string
        if (body.files && body.files.length > 0) {
          const fileLines = body.files.map(f =>
            `[${body.text} (${f.mime_type}) — ${f.path}. Use the Read tool to view it.]`
          )
          content = fileLines.join('\n')
        } else {
          content = body.text
        }

        // Push notification into Claude Code session (fire-and-forget)
        mcp
          .notification({
            method: 'notifications/claude/channel',
            params: {
              content,
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
            completed.set(request_id, { response: '', elapsed_ms: Date.now() - submitted_at })
            erroredRequests.add(request_id)
            scheduleCompletedCleanup(request_id)
            process.stderr.write(`voice-channel: failed to deliver to Claude: ${err}\n`)
          })

        return Response.json({ request_id, status: 'pending' }, { status: 202 })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json({ error: msg }, { status: 500 })
      }
    }

    // Poll for voice request result
    const pollMatch = url.pathname.match(/^\/voice\/([a-f0-9]+)$/)
    if (pollMatch && req.method === 'GET') {
      const request_id = pollMatch[1]

      // Check completed (success or error)
      const done = completed.get(request_id)
      if (done) {
        if (erroredRequests.has(request_id)) {
          erroredRequests.delete(request_id)
          completed.delete(request_id)
          return Response.json({
            request_id,
            status: 'error',
            error: 'Voice request timed out or failed to deliver',
            elapsed_ms: done.elapsed_ms,
          })
        }
        return Response.json({
          request_id,
          status: 'completed',
          response: done.response,
          elapsed_ms: done.elapsed_ms,
        })
      }

      // Check still pending
      if (pending.has(request_id)) {
        const entry = pending.get(request_id)!
        return Response.json({
          request_id,
          status: 'pending',
          elapsed_ms: Date.now() - entry.submitted_at,
        })
      }

      return Response.json({ error: `Unknown request_id: ${request_id}` }, { status: 404 })
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

  // Move all pending requests to error state so orchestrator sees them on next poll
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    completed.set(id, { response: '', elapsed_ms: Date.now() - entry.submitted_at })
    erroredRequests.add(id)
    pending.delete(id)
  }

  httpServer.stop()
  setTimeout(() => process.exit(0), 500)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
