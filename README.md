# X32-mcp

Master MCP Server for the **Behringer X32** digital mixing console.  
Exposes the full X32 parameter set as [Model Context Protocol (MCP)](https://modelcontextprotocol.io) tools so that LLMs can control the mixer in real-time via OSC over UDP.

---

## Requirements

- Node.js ≥ 18
- A Behringer X32 (or X32 RACK / X32 COMPACT / X32 PRODUCER) reachable on the network

---

## Installation

```bash
npm install
npm run build
```

## Configuration

Set the `X32_IP` environment variable to the IP address of your X32 (default: `192.168.0.1`):

```bash
export X32_IP=192.168.1.100
npm start
```

## Usage with an MCP Client

Add this server to your MCP client configuration:

```json
{
  "mcpServers": {
    "x32": {
      "command": "node",
      "args": ["/path/to/x32-mcp/dist/index.js"],
      "env": {
        "X32_IP": "192.168.1.100"
      }
    }
  }
}
```

---

## Available Tools

| Tool | Description |
|------|-------------|
| `set_fader` | Adjust fader level (0–1) of a channel, bus, aux, FX return, matrix or main |
| `set_mute` | Mute or unmute a channel, bus, DCA, etc. |
| `config_dca` | Assign or unassign a channel to/from a DCA group (1-8) |
| `set_pan` | Set stereo pan of an input channel (−1.0 … +1.0) |
| `set_channel_label` | Configure scribble strip name, colour and icon |
| `set_fx_type` | Set the FX processor type in an FX rack slot (1-8) |
| `set_fx_parameter` | Adjust a parameter of an FX processor (normalised 0–1) |
| `set_fx_send` | Set send level from a channel to an FX bus (13-16) |
| `set_eq` | Adjust a parametric EQ band (frequency, gain, Q) |
| `set_dyn_comp` | Set compressor parameters (threshold, ratio, attack, release, knee) |
| `set_preamp_gain` | Set preamp gain (0–72 dB) and phantom power (+48V) |
| `set_matrix_send` | Set send level from a mix bus to a matrix output |
| `route_input` | Assign a physical input source to an input channel |

---

## dB → Fader Conversion

The X32 uses a non-linear fader curve. Use the built-in formula to convert dB to normalised fader values:

```
f(dB) = (dB + 30) / 40 + 0.5    if dB ≥ −30
f(dB) = (dB + 90) / 120          if dB <  −30
```

Examples:

| dB | Fader (0–1) |
|----|-------------|
| 0  | 0.750 |
| −6 | 0.600 |
| −20 | 0.250 |
| −30 | 0.500 |
| −60 | 0.250 |
| −90 | 0.000 |
| −∞ | 0.000 |

---

## Scribble Strip Color IDs

| ID | Color |
|----|-------|
| 0  | Off (no colour) |
| 1  | Red |
| 2  | Green |
| 3  | Yellow |
| 4  | Blue |
| 5  | Magenta |
| 6  | Cyan |
| 7  | White |

---

## Scribble Strip Icon IDs (1–74)

The X32 supports 74 built-in icons for the scribble strip display.  
Below is the full reference table:

| ID | Icon | ID | Icon | ID | Icon | ID | Icon |
|----|------|----|------|----|------|----|------|
| 1  | Kick drum | 2  | Snare | 3  | Hi-hat (closed) | 4  | Hi-hat (open) |
| 5  | Tom | 6  | Floor tom | 7  | Overhead | 8  | Drum kit |
| 9  | Bass guitar | 10 | Electric guitar | 11 | Acoustic guitar | 12 | Guitar amp |
| 13 | Electric piano | 14 | Grand piano | 15 | Organ | 16 | Keyboard |
| 17 | Synthesizer | 18 | Violin | 19 | Viola | 20 | Cello |
| 21 | Bass (strings) | 22 | Trumpet | 23 | Trombone | 24 | French horn |
| 25 | Saxophone | 26 | Flute | 27 | Clarinet | 28 | Oboe |
| 29 | Vocal male | 30 | Vocal female | 31 | Choir | 32 | Headphones |
| 33 | Talkback | 34 | Wireless mic | 35 | Handheld mic | 36 | Clip-on mic |
| 37 | Overhead mic | 38 | Stereo mic | 39 | DI box | 40 | Playback |
| 41 | FX return | 42 | Sub bass | 43 | Monitor wedge | 44 | In-ear monitor |
| 45 | Speaker L | 46 | Speaker R | 47 | Main LR | 48 | Mono/Centre |
| 49 | Matrix out 1 | 50 | Matrix out 2 | 51 | Matrix out 3 | 52 | Matrix out 4 |
| 53 | Matrix out 5 | 54 | Matrix out 6 | 55 | Bus mix 1 | 56 | Bus mix 2 |
| 57 | Bus mix 3 | 58 | Bus mix 4 | 59 | Bus mix 5 | 60 | Bus mix 6 |
| 61 | Bus mix 7 | 62 | Bus mix 8 | 63 | DCA group | 64 | Mute group |
| 65 | Effects 1 | 66 | Effects 2 | 67 | Effects 3 | 68 | Effects 4 |
| 69 | Reverb | 70 | Delay | 71 | Chorus | 72 | Pitch |
| 73 | Dynamics | 74 | Equalizer | | | | |

---

## Input Source Naming

When using the `route_input` tool, use the following naming conventions for the `source` parameter:

| Source | Format | Examples |
|--------|--------|---------|
| Local analogue inputs | `Local N` | `Local 1`, `Local 16` |
| AES50 port A (e.g. S16 stage box) | `AES50 AN` | `AES50 A1`, `AES50 A32` |
| AES50 port B | `AES50 BN` | `AES50 B1`, `AES50 B32` |
| Expansion card | `Card N` | `Card 1`, `Card 32` |

---

## License

MIT
