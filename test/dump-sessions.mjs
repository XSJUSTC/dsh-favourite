// Dump session summaries for the virtual DSH (titles + blank flags).
const token = process.argv[2]
const auth = await fetch(`http://127.0.0.1:34411/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (auth.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).filter((p) => p.startsWith('dsh-auth-')).join('; ')
const res = await fetch('http://127.0.0.1:34411/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ type: 'client-request', rpcId: 'dump', method: 'session/list', payload: { args: { _request: {} } } })
})
const body = await res.json()
for (const item of body.result.value.items) {
  const title = item.displayTitle ?? item.title ?? null
  console.log(item.sessionId.slice(0, 13), 'blank=' + item.blank, 'title=' + JSON.stringify(title))
}
