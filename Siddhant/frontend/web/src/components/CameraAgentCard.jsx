import { useEffect, useState } from 'react'

// The camera agent on this PC (vision/camera_agent.py). Set VITE_CAMERA_AGENT_URL only on the computer with the
// bus camera; everywhere else this card does not appear.
const AGENT = import.meta.env.VITE_CAMERA_AGENT_URL

async function agent(method, body) {
  const r = await fetch(`${AGENT}/camera`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`camera agent ${r.status}`)
  return r.json()
}

/** "Camera on this PC": when the driver's bus for today is set (or changed), the camera starts counting it. */
export default function CameraAgentCard({ busId }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!AGENT || !busId) return
    let alive = true
    agent('POST', { bus: busId })
      .then((s) => { if (alive) { setState(s); setError('') } })
      .catch(() => { if (alive) setError('The camera agent on this PC is not running.') })
    const t = setInterval(() => {
      agent('GET').then((s) => alive && setState(s)).catch(() => alive && setError('The camera agent on this PC is not running.'))
    }, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [busId])

  if (!AGENT) return null
  const counting = state?.running && state.bus === busId
  return (
    <section className="card">
      <div className="row-between">
        <div>
          <div className="eyebrow">Camera on this PC</div>
          <div className={counting ? 'good-text' : 'muted'}>
            {error || (counting ? `Counting people on Bus ${busId}` : state?.bus ? `Counting Bus ${state.bus}` : 'Camera off')}
          </div>
          {counting && state.restarts > 0 && <div className="tiny muted">Restarted {state.restarts}× after it stopped.</div>}
        </div>
        {counting
          ? <button className="btn ghost small" onClick={() => agent('DELETE').then(setState).catch(() => {})}>Stop camera</button>
          : <button className="btn primary small" onClick={() => agent('POST', { bus: busId }).then(setState).catch(() => {})}>Start camera</button>}
      </div>
    </section>
  )
}
