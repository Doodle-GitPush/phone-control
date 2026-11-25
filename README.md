# 🖌️ Phone Paint (ZIGSIM edition)

Turn your phone into a paintbrush for a whiteboard on your computer, using the
[**ZIGSIM**](https://1-10.github.io/zigsim/) app to stream the phone's real
sensors. Tilt the phone to move the brush; hold a finger on the phone to paint.
First step toward phone-as-controller games (e.g. table tennis).

## How it works

```
 Phone (ZIGSIM app)                    Computer (index.html)
 ─ gravity/quaternion → tilt           ─ full-screen canvas
 ─ touch → pen down       ──UDP/JSON──► ─ Node maps sensors → brush x,y
                                        ─ draws strokes + live cursor
        Node (dgram UDP :50000)  +  Socket.IO (HTTP :3000)
```

ZIGSIM is a native app, so it reads the phone's sensors directly and sends them
over the network — no browser permissions and no HTTPS needed. The server
listens for ZIGSIM's UDP/JSON packets, maps gravity (or quaternion) to a brush
position and touch to "pen down", and relays to the whiteboard over Socket.IO.

## Run it

```bash
npm install      # first time only
npm start
```

### On the computer
Open <http://localhost:3000>. The setup card shows the exact address + port to
type into ZIGSIM.

### On the phone (ZIGSIM app, same Wi-Fi)
| Setting   | Value                          |
|-----------|--------------------------------|
| Protocol  | UDP                            |
| Format    | JSON                           |
| Address   | your computer's LAN IP (shown in the terminal / setup card) |
| Port      | `50000`                        |
| Sensors   | Gravity + Quaternion + Touch   |

Press **Start** in ZIGSIM. The status pill on the whiteboard turns green when
packets arrive.

### Painting
- **Tilt** the phone to move the brush (the cursor ring moves even when not
  painting, so you can aim).
- **Hold a finger on the ZIGSIM screen** to paint. If your ZIGSIM build has no
  Touch sensor, **hold the SPACE bar** on the computer instead.
- Keyboard: **R** recenter (resets the neutral tilt to how you're holding it),
  **C** clear, **S** save PNG. Color + brush size live in the top toolbar.

## Config / env vars

| Var          | Default | Meaning                                            |
|--------------|---------|----------------------------------------------------|
| `PORT`       | `3000`  | Whiteboard (browser) port                          |
| `ZIGSIM_PORT`| `50000` | UDP port ZIGSIM sends to                           |
| `HTTPS`      | unset   | `HTTPS=1` enables the optional in-browser brush at `/controller.html` over a self-signed cert (no ZIGSIM needed) |

## Troubleshooting

- **Status stays grey / no packets:** double-check the Address (your computer's
  LAN IP, not localhost), Port `50000`, Protocol `UDP`, Format `JSON`. Phone and
  computer must be on the **same Wi-Fi**, and the network must allow
  device-to-device traffic.
- **macOS firewall:** if prompted, **Allow** incoming connections for `node`.
  System Settings ▸ Network ▸ Firewall may otherwise block ZIGSIM's UDP.
- **Server logs `non-JSON packet`:** set ZIGSIM's output format to **JSON**
  (it defaults to OSC). The server prints the first packets it receives so the
  sensor schema can be confirmed.
- **Brush moves the wrong way / too fast:** the axis signs and gain are easy to
  tune in `mapZig()` in `server.js` (the first real packet in the log tells us
  the exact values).

## Files

| File | Role |
|------|------|
| `server.js` | Static server + Socket.IO + **ZIGSIM UDP listener & sensor mapping** |
| `public/index.html` + `whiteboard.js` | The whiteboard (computer) |
| `public/controller.html` + `controller.js` | Optional in-browser brush (only used with `HTTPS=1`) |
