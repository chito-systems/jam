import { describe, expect, it } from 'vitest'
import { agentCount, mcpCommand, phoneSteps, type Signals, setupLine, stepStatus } from './steps'

const base: Signals = {
  identity: { team: 'jam', who: 'jake', persisted: true },
  standalone: false,
  mic: 'unknown',
  docs: [],
  stats: { by_who: {} },
  bridge: 'not running',
}

describe('setup guide status', () => {
  it('a fresh sign-in has only the first step done', () => {
    const s = stepStatus(base)
    expect(s).toEqual({ in: true, install: false, mic: false, say: false, agent: false, terminal: false })
    expect(setupLine(s)).toBe('1 of 6 set up')
  })

  it('every step reads its own live signal', () => {
    const s = stepStatus({
      ...base,
      standalone: true,
      mic: 'granted',
      docs: [{ who: 'cam' }, { who: 'jake' }],
      stats: { by_who: { jake: 2, 'agent:jake-agent': 4 } },
      bridge: 'running',
    })
    expect(setupLine(s)).toBe('6 of 6 set up')
  })

  it('does not count someone else, a denied or unknown mic, a human-only brain, or a bridge still checking', () => {
    const s = stepStatus({ ...base, mic: 'denied', docs: [{ who: 'cam' }], stats: { by_who: { cam: 3 } }, bridge: 'checking' })
    expect(setupLine(s)).toBe('1 of 6 set up')
    expect(stepStatus({ ...base, mic: 'prompt' }).mic).toBe(false)
    expect(stepStatus({ ...base, stats: undefined }).agent).toBe(false)
  })

  it('ticks the agent step only for your own agent, not a teammate\'s', () => {
    expect(stepStatus({ ...base, stats: { by_who: { 'agent:cam-agent': 5, 'agent:opus-1': 2 } } }).agent).toBe(false)
    expect(stepStatus({ ...base, stats: { by_who: { 'agent:jake-agent': 1 } } }).agent).toBe(true)
  })

  it('counts your first entry from the whole-brain totals, even when it has scrolled out of the recent list', () => {
    expect(stepStatus({ ...base, docs: [], stats: { by_who: { jake: 1 } } }).say).toBe(true)
  })

  it('counts distinct agents only', () => {
    expect(agentCount({ by_who: { cam: 1, 'agent:a': 1, 'agent:b': 9 } })).toBe(2)
    expect(agentCount(undefined)).toBe(0)
  })
})

describe('mcp command', () => {
  const url = (cmd: string) => new URL(cmd.match(/"(.+)"$/)?.[1] ?? '')

  it('builds the exact command from origin, team, name and side', () => {
    expect(mcpCommand('https://jam.example.com', { team: 'jam', who: 'jake' }, 'frontend')).toBe(
      'claude mcp add hack-harness-context --scope user --transport http "https://jam.example.com/mcp?team_id=jam&who=jake-agent&side=frontend"',
    )
  })

  it('keeps an origin with a port and the chosen side', () => {
    const u = url(mcpCommand('http://localhost:5199', { team: 't', who: 'cam' }, 'backend'))
    expect(u.host).toBe('localhost:5199')
    expect(u.pathname).toBe('/mcp')
    expect(u.searchParams.get('side')).toBe('backend')
  })

  it('encodes odd team codes and names so the shell and the server read them back intact', () => {
    const cmd = mcpCommand('https://x.dev', { team: 'a&b "c"$!', who: 'jo é' }, 'frontend')
    const query = cmd.slice(cmd.indexOf('mcp?'), -1)
    expect(query).not.toMatch(/["$!`\\ ]/)
    const u = url(cmd)
    expect(u.searchParams.get('team_id')).toBe('a&b "c"$!')
    expect(u.searchParams.get('who')).toBe('jo é-agent')
  })

  it('fits who in the 56 characters the MCP server accepts', () => {
    const who = url(mcpCommand('https://x.dev', { team: 't', who: 'n'.repeat(64) }, 'backend')).searchParams.get('who') ?? ''
    expect(who.length).toBe(56)
    expect(who.endsWith('-agent')).toBe(true)
  })
})

describe('phone setup', () => {
  it('keeps agents and the terminal off the phone, and the home screen out of the app', () => {
    expect(phoneSteps(true)).toEqual(['in', 'mic', 'say'])
    expect(phoneSteps(false)).toEqual(['in', 'mic', 'say', 'install'])
  })
  it('counts only the phone steps', () => {
    const status = { in: true, install: false, mic: true, say: false, agent: false, terminal: false }
    expect(setupLine(status, phoneSteps(true))).toBe('2 of 3 set up')
  })
})
