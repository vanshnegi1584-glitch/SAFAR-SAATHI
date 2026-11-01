# SafarSaathi demo — one command

```powershell
powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\start-demo.ps1
```

It starts, in order and each in its own window (titled "SafarSaathi - …"):

| Window | What it is | Port |
|---|---|---|
| vision bridge (bus 18) | combines the camera count with door-counter data | 8010 |
| GPS tracking server | live bus GPS (in memory; the script restores stops and route paths from `GPS/data/stop-locations.json`) | 4000 |
| SafarSaathi backend | Siddhant's API, on the team Supabase database | 8000 |
| simulated buses | 7 test buses on their approved routes (bus 18's GPS; the others also get simulated passenger counts) | 8021–8026 |
| GPS feed to SafarSaathi | forwards bus positions into the SafarSaathi backend | — |
| SafarSaathi website | the website | 5173 |
| TransitLink dispatcher website | Vidhu's dispatcher (Live GPS) | 3000 |
| **AI camera counter (bus 18)** | **opens a window showing what the AI detects** and sends the people count every second | — |

Then it opens <http://localhost:5173/live> (and <http://localhost:3000/tracking>).

**For the evaluator:** stand in front of the webcam. The camera window draws a box and an ID on each person;
within about a second, Bus 18's "on board" and "seats free" change on the website (Live buses page, the bus 18 card;
also on the passenger/staff/office pages after logging in), and on TransitLink's Live GPS page.

Stop everything: `powershell -ExecutionPolicy Bypass -File D:\SAFAR-SAATHI\demo\stop-demo.ps1`

Options: `-NoSimulator` (only bus 18), `-NoTransitLink` (skip the dispatcher site).

Notes
- Local development setup: the GPS server runs its in-memory dev mode with dev tokens. Not for a deployed system.
- The SafarSaathi backend writes live bus state into the **shared team database**; don't run it while Siddhant runs his.
- If the camera window is closed by mistake, the counter restarts by itself after 3 s.
- Bus 18 waits at campus for up to 45 s on departures (one webcam can't fill 41 seats), then leaves.
