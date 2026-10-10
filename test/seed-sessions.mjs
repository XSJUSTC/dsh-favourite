/**
 * Seed minimal completed-turn sessions into a DSH home so the workspace
 * registry bootstraps real workspaces and the fork RPC has a turn/end
 * boundary to cut at.
 *
 * Usage: node test/seed-sessions.mjs <dshHome> <cwd> <count> [titleText]
 * Prints one JSON line per seeded session: { id, cwd, file }.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const [, , home, cwd, countArg, titleText = 'seeded session'] = process.argv
if (home === undefined || cwd === undefined || countArg === undefined) {
  console.error('usage: node test/seed-sessions.mjs <dshHome> <cwd> <count> [titleText]')
  process.exit(2)
}
const count = Number(countArg)

/** Mirrors dsh-session-persistence-jsonl projectKey(): separators/colon → '-', collapsed, wrapped in '--'. */
function projectKey(value) {
  let readable = ''
  let separatorRun = false
  for (const ch of value) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${readable.replace(/^-+/, '') || 'root'}--`
}

const now = Date.now()
const seeded = []

for (let index = 0; index < count; index++) {
  const id = `session-${randomUUID()}`
  const events = [
    { type: 'session', version: 3, id, createdAt: now, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
    { type: 'turn/start', seq: 0, time: now, data: { turn: 0 } },
    {
      type: 'user/message',
      seq: 1,
      time: now + 1,
      data: {
        content: [{ type: 'text', text: `${titleText} ${index + 1}` }],
        source: { kind: 'user' },
        role: 'user',
        id: randomUUID()
      },
      surfaceOp: 'append'
    },
    { type: 'turn/end', seq: 2, time: now + 2, data: { turn: 0, reason: { kind: 'completed' } } }
  ]
  // One zstd frame per record, matching the writer's per-batch framing.
  const payload = Buffer.concat(events.map((event) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'))))
  const dir = path.join(home, 'sessions', projectKey(cwd), id)
  const file = path.join(dir, 'session.v3.jsonl.zstd')
  await mkdir(dir, { recursive: true })
  await writeFile(file, payload)
  seeded.push({ id, cwd, file })
}

for (const entry of seeded) console.log(JSON.stringify(entry))
