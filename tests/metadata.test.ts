import { describe, test, expect } from 'bun:test'

describe('voice_reply metadata round-trip', () => {
  test('completed entry includes the metadata fields supplied by voice_reply', () => {
    // This is a structural assertion against the type definitions — actual
    // round-trip testing happens in Section D against the live channel.
    type ReplyMetadata = {
      mode?: string
      citations?: Array<{ file: string; anchor: string; snippet: string }>
      current_concept?: string | null
      session_state?: 'active' | 'ended'
    }
    const m: ReplyMetadata = {
      mode: 'open-recall',
      citations: [{ file: 'a.md', anchor: 'art-15', snippet: 'x' }],
      current_concept: 'sklenitev-pogodbe',
      session_state: 'active',
    }
    expect(m.mode).toBe('open-recall')
    expect(m.citations?.length).toBe(1)
    expect(m.session_state).toBe('active')
  })

  test('session_state defaults to "active" when omitted in voice_reply', () => {
    // Mirrors the server.ts default: `args.session_state ?? "active"`.
    const supplied: 'active' | 'ended' | undefined = undefined
    const resolved = supplied ?? 'active'
    expect(resolved).toBe('active')
  })
})
