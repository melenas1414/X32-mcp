#!/usr/bin/env node
/**
 * X32-MCP — Master MCP Server for Behringer X32
 *
 * Exposes the full X32 parameter set as MCP tools so that LLMs can
 * control the mixer in real-time via OSC over UDP (port 10023).
 *
 * Configuration:
 *   X32_IP  — IP address of the X32 (default: 192.168.0.1)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client, Bundle, Message } from "node-osc";
import { z } from "zod";

// ─── Global configuration ──────────────────────────────────────────────────

const X32_IP: string = process.env["X32_IP"] ?? "192.168.0.1";
const X32_PORT = 10023;
const XREMOTE_INTERVAL_MS = 9000;

// ─── Math helpers ──────────────────────────────────────────────────────────

/**
 * Maps a dB value to the X32 fader position (0–1).
 *
 * Approximation of the X32 logarithmic fader curve:
 *   dB ≥ -30 → (dB + 30) / 40 + 0.5
 *   dB <  -30 → (dB + 90) / 120
 */
function dbToFader(dB: number): number {
  if (dB >= -30) {
    return (dB + 30) / 40 + 0.5;
  }
  return (dB + 90) / 120;
}

/**
 * Maps a pan value (−1.0 … +1.0) to the X32 OSC range (0.0 … 1.0).
 * 0.0 = hard left, 0.5 = centre, 1.0 = hard right.
 */
function panToOsc(pan: number): number {
  return (pan + 1) / 2;
}

/**
 * Maps a frequency in Hz (20–20 000) to the X32 logarithmic OSC range (0–1).
 */
function freqToOsc(f: number): number {
  const lo = Math.log10(20);
  const hi = Math.log10(20_000);
  return (Math.log10(f) - lo) / (hi - lo);
}

/**
 * Maps an EQ gain value (−15 … +15 dB) to the X32 OSC range (0–1).
 */
function eqGainToOsc(g: number): number {
  return (g + 15) / 30;
}

/**
 * Maps a Q factor (0.3–10) to the X32 logarithmic OSC range (0–1).
 */
function qToOsc(q: number): number {
  const lo = Math.log10(0.3);
  const hi = Math.log10(10);
  return (Math.log10(q) - lo) / (hi - lo);
}

/**
 * Formats a channel / bus / aux number as a zero-padded two-digit string.
 * e.g. 1 → "01", 12 → "12"
 */
function pad(id: number): string {
  return id.toString().padStart(2, "0");
}

/**
 * Returns the OSC address prefix for a given channel type.
 * For "main" the id argument is ignored.
 */
function channelPath(type: string, id: number): string {
  if (type === "main") return "/main/st";
  return `/${type}/${pad(id)}`;
}

// ─── Input source routing table ────────────────────────────────────────────

/**
 * Maps human-readable source names to X32 routing integers.
 * Local inputs: 0–31 (Local 1–32)
 * AES50-A:      32–63
 * AES50-B:      64–95
 * Card:         96–127
 */
function resolveInputSource(source: string): number {
  const s = source.trim();

  const localMatch = /^Local\s+(\d+)$/i.exec(s);
  if (localMatch) return parseInt(localMatch[1]!, 10) - 1;

  const aes50aMatch = /^AES50\s*A\s*(\d+)$/i.exec(s);
  if (aes50aMatch) return 32 + parseInt(aes50aMatch[1]!, 10) - 1;

  const aes50bMatch = /^AES50\s*B\s*(\d+)$/i.exec(s);
  if (aes50bMatch) return 64 + parseInt(aes50bMatch[1]!, 10) - 1;

  const cardMatch = /^Card\s+(\d+)$/i.exec(s);
  if (cardMatch) return 96 + parseInt(cardMatch[1]!, 10) - 1;

  throw new Error(
    `Fuente de entrada desconocida: "${source}". ` +
      `Formatos válidos: "Local 1"–"Local 32", "AES50 A1"–"AES50 A32", ` +
      `"AES50 B1"–"AES50 B32", "Card 1"–"Card 32".`
  );
}

// ─── OSC client ────────────────────────────────────────────────────────────

class X32OscClient {
  private readonly client: Client;

  constructor(host: string, port: number) {
    this.client = new Client(host, port);
  }

  /** Send a single OSC message or an OSC bundle. */
  async send(msg: Message | Bundle): Promise<void> {
    await this.client.send(msg as Parameters<typeof this.client.send>[0]);
  }

  /** Send an OSC bundle containing multiple messages atomically. */
  async sendBundle(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    if (messages.length === 1) {
      await this.send(messages[0]!);
      return;
    }
    const bundle = new Bundle(...(messages as [Message, ...Message[]]));
    await this.send(bundle);
  }

  /**
   * Start the /xremote keep-alive.
   * The X32 requires this command every <10 s to keep sending status updates.
   */
  startXRemote(): void {
    const ping = (): void => {
      const result = this.client.send(new Message("/xremote"));
      result?.catch((err: unknown) =>
        process.stderr.write(`[xremote] ${String(err)}\n`)
      );
    };
    ping();
    setInterval(ping, XREMOTE_INTERVAL_MS).unref();
  }

  /** Close the underlying UDP socket gracefully. */
  async close(): Promise<void> {
    await this.client.close();
  }
}

// ─── MCP server setup ──────────────────────────────────────────────────────

const osc = new X32OscClient(X32_IP, X32_PORT);

const server = new McpServer(
  { name: "x32-mcp", version: "1.0.0" },
  {
    capabilities: { tools: {} },
  }
);

// ─── Tool: set_fader ───────────────────────────────────────────────────────

server.tool(
  "set_fader",
  "Ajusta el nivel del fader de un canal, aux, retorno de FX, bus, matriz o salida principal. " +
    "El nivel va de 0.0 (−∞ dB, silencio total) a 1.0 (0 dB, nivel nominal). " +
    "Usa la función dbToFader() para convertir valores en dB al rango 0-1.",
  {
    type: z.enum(["ch", "aux", "fxrtn", "bus", "mtx", "main"]).describe(
      "Tipo de canal: 'ch'=canal, 'aux'=entrada auxiliar, 'fxrtn'=retorno FX, " +
        "'bus'=mezcla de bus, 'mtx'=salida de matriz, 'main'=salida principal"
    ),
    id: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe(
        "Número de canal (1-32). Ignorado cuando type='main'."
      ),
    level: z
      .number()
      .min(0)
      .max(1)
      .describe("Nivel del fader en rango normalizado 0.0–1.0."),
  },
  async ({ type, id, level }) => {
    const path = `${channelPath(type, id)}/mix/fader`;
    await osc.send(new Message(path, { type: "float", value: level }));
    return {
      content: [
        {
          type: "text",
          text: `Fader ${type}/${type === "main" ? "ST" : pad(id)} ajustado a ${level.toFixed(4)} (OSC: ${path})`,
        },
      ],
    };
  }
);

// ─── Tool: set_mute ────────────────────────────────────────────────────────

server.tool(
  "set_mute",
  "Silencia o activa un canal, bus, aux, retorno de FX, matriz o salida principal. " +
    "En el X32, 'on' (valor 1) significa activo (sin silencio) y 'off' (valor 0) silenciado.",
  {
    type: z
      .string()
      .describe(
        "Tipo de canal: 'ch', 'aux', 'fxrtn', 'bus', 'mtx', 'main', 'dca'."
      ),
    id: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe(
        "Número de canal (1-32). Para DCA usar 1-8. Ignorado cuando type='main'."
      ),
    mute: z
      .boolean()
      .describe("true = silenciar el canal, false = activar el canal."),
  },
  async ({ type, id, mute }) => {
    let path: string;
    if (type === "dca") {
      path = `/dca/${id}/on`;
    } else {
      path = `${channelPath(type, id)}/mix/on`;
    }
    // X32 convention: 1 = active (unmuted), 0 = muted
    const value = mute ? 0 : 1;
    await osc.send(new Message(path, { type: "integer", value }));
    return {
      content: [
        {
          type: "text",
          text: `Canal ${type}/${type === "main" ? "ST" : pad(id)} ${mute ? "silenciado" : "activado"} (OSC: ${path} = ${value})`,
        },
      ],
    };
  }
);

// ─── Tool: config_dca ──────────────────────────────────────────────────────

server.tool(
  "config_dca",
  "Asigna o desasigna un canal de entrada a un grupo DCA. " +
    "Los grupos DCA (1-8) permiten controlar múltiples canales simultáneamente " +
    "desde un único fader master.",
  {
    dca_id: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("Número del grupo DCA (1-8)."),
    channel_id: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada que se asigna/desasigna (1-32)."),
    mode: z
      .enum(["assign", "unassign"])
      .describe(
        "'assign' = asignar el canal al DCA, 'unassign' = quitar el canal del DCA."
      ),
  },
  async ({ dca_id, channel_id, mode }) => {
    // The X32 stores per-channel DCA membership as a bit-mask integer at
    // /ch/XX/config/defader — bit N (0-based) corresponds to DCA N+1.
    // For a simpler single-operation approach we toggle the DCA on/off state.
    const dcaOnPath = `/dca/${dca_id}/on`;
    const chGrpPath = `/ch/${pad(channel_id)}/grp/dca`;

    // Build the DCA bitmask bit for this DCA (bit index = dca_id - 1)
    const bit = 1 << (dca_id - 1);
    const messages: Message[] = [
      new Message(dcaOnPath, { type: "integer", value: 1 }),
      new Message(chGrpPath, {
        type: "integer",
        value: mode === "assign" ? bit : 0,
      }),
    ];
    await osc.sendBundle(messages);
    return {
      content: [
        {
          type: "text",
          text:
            `Canal ${pad(channel_id)} ${mode === "assign" ? "asignado a" : "desasignado de"} ` +
            `DCA ${dca_id} (bitmask: ${bit})`,
        },
      ],
    };
  }
);

// ─── Tool: set_pan ─────────────────────────────────────────────────────────

server.tool(
  "set_pan",
  "Ajusta la panoramización estéreo de un canal de entrada. " +
    "−1.0 = totalmente a la izquierda, 0.0 = centro, +1.0 = totalmente a la derecha.",
  {
    id: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada (1-32)."),
    pan: z
      .number()
      .min(-1)
      .max(1)
      .describe(
        "Posición de panoramización: -1.0 (izquierda) a +1.0 (derecha), 0.0 = centro."
      ),
  },
  async ({ id, pan }) => {
    const path = `/ch/${pad(id)}/mix/pan`;
    const oscValue = panToOsc(pan);
    await osc.send(new Message(path, { type: "float", value: oscValue }));
    return {
      content: [
        {
          type: "text",
          text: `Pan del canal ${pad(id)} ajustado a ${pan.toFixed(3)} → OSC ${oscValue.toFixed(4)} (${path})`,
        },
      ],
    };
  }
);

// ─── Tool: set_channel_label ───────────────────────────────────────────────

server.tool(
  "set_channel_label",
  "Configura el nombre, color de fondo e icono del scribble strip de un canal. " +
    "Los colores disponibles son: 0=Off, 1=Rojo, 2=Verde, 3=Amarillo, " +
    "4=Azul, 5=Magenta, 6=Cian, 7=Blanco. " +
    "Los iconos van del 1 al 74 (ver README para la tabla completa).",
  {
    id: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada (1-32)."),
    name: z
      .string()
      .max(12)
      .describe("Nombre del canal (máximo 12 caracteres)."),
    color: z
      .number()
      .int()
      .min(0)
      .max(7)
      .describe(
        "Color del scribble strip: 0=Off, 1=Rojo, 2=Verde, 3=Amarillo, " +
          "4=Azul, 5=Magenta, 6=Cian, 7=Blanco."
      ),
    icon: z
      .number()
      .int()
      .min(1)
      .max(74)
      .describe("Número de icono del scribble strip (1-74)."),
  },
  async ({ id, name, color, icon }) => {
    const ch = pad(id);
    const messages: Message[] = [
      new Message(`/ch/${ch}/config/name`, name),
      new Message(`/ch/${ch}/config/color`, { type: "integer", value: color }),
      new Message(`/ch/${ch}/config/icon`, { type: "integer", value: icon }),
    ];
    await osc.sendBundle(messages);
    return {
      content: [
        {
          type: "text",
          text: `Scribble strip del canal ${ch} actualizado: nombre="${name}", color=${color}, icono=${icon}`,
        },
      ],
    };
  }
);

// ─── Tool: set_fx_type ─────────────────────────────────────────────────────

server.tool(
  "set_fx_type",
  "Establece el tipo de procesador de efecto en un slot del rack de FX interno del X32. " +
    "Los slots 1-4 corresponden a los FX de inserción y los slots 5-8 a los FX de bus. " +
    "El tipo 1 = Stereo GEQ, 2 = True Peak Limiter, … (consultar manual para lista completa 1-61).",
  {
    slot: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("Número del slot del rack de FX (1-8)."),
    type: z
      .number()
      .int()
      .min(1)
      .max(61)
      .describe("Tipo de efecto (1-61, ver documentación del X32)."),
  },
  async ({ slot, type }) => {
    const path = `/fx/${slot}/type`;
    await osc.send(new Message(path, { type: "integer", value: type }));
    return {
      content: [
        {
          type: "text",
          text: `Slot FX ${slot} configurado con tipo de efecto ${type} (${path})`,
        },
      ],
    };
  }
);

// ─── Tool: set_fx_parameter ────────────────────────────────────────────────

server.tool(
  "set_fx_parameter",
  "Ajusta un parámetro específico del procesador de efectos en un slot del rack de FX. " +
    "El valor está normalizado en el rango 0.0–1.0 independientemente del tipo de parámetro.",
  {
    slot: z
      .number()
      .int()
      .min(1)
      .max(8)
      .describe("Número del slot del rack de FX (1-8)."),
    param_id: z
      .number()
      .int()
      .min(1)
      .max(64)
      .describe("Número del parámetro dentro del efecto (1-64)."),
    value: z
      .number()
      .min(0)
      .max(1)
      .describe("Valor normalizado del parámetro (0.0–1.0)."),
  },
  async ({ slot, param_id, value }) => {
    const path = `/fx/${slot}/par/${pad(param_id)}`;
    await osc.send(new Message(path, { type: "float", value }));
    return {
      content: [
        {
          type: "text",
          text: `Parámetro ${param_id} del slot FX ${slot} ajustado a ${value.toFixed(4)} (${path})`,
        },
      ],
    };
  }
);

// ─── Tool: set_fx_send ─────────────────────────────────────────────────────

server.tool(
  "set_fx_send",
  "Ajusta el nivel de envío de un canal de entrada hacia un bus de retorno de efectos. " +
    "Los buses FX ocupan las posiciones 13-16 dentro de los mix sends. " +
    "Nivel 0.0 = sin señal, 1.0 = unidad (0 dB).",
  {
    channel: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de origen (1-32)."),
    fx_bus: z
      .number()
      .int()
      .min(13)
      .max(16)
      .describe("Número del bus FX de destino (13-16)."),
    level: z
      .number()
      .min(0)
      .max(1)
      .describe("Nivel de envío normalizado (0.0–1.0)."),
  },
  async ({ channel, fx_bus, level }) => {
    const path = `/ch/${pad(channel)}/mix/${pad(fx_bus)}/level`;
    await osc.send(new Message(path, { type: "float", value: level }));
    return {
      content: [
        {
          type: "text",
          text: `Envío del canal ${pad(channel)} al bus FX ${fx_bus} ajustado a ${level.toFixed(4)} (${path})`,
        },
      ],
    };
  }
);

// ─── Tool: set_eq ──────────────────────────────────────────────────────────

server.tool(
  "set_eq",
  "Ajusta una banda del ecualizador paramétrico de 4 bandas del Fat Channel de un canal. " +
    "Cada banda tiene frecuencia central (f), ganancia (g) y factor Q (q). " +
    "Los valores de frecuencia, ganancia y Q se convierten automáticamente al rango OSC del X32.",
  {
    ch: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada (1-32)."),
    band: z
      .number()
      .int()
      .min(1)
      .max(4)
      .describe("Número de banda del EQ (1=Low, 2=Low-Mid, 3=High-Mid, 4=High)."),
    f: z
      .number()
      .min(20)
      .max(20_000)
      .describe("Frecuencia central de la banda en Hz (20–20 000 Hz)."),
    g: z
      .number()
      .min(-15)
      .max(15)
      .describe("Ganancia de la banda en dB (−15 a +15 dB)."),
    q: z
      .number()
      .min(0.3)
      .max(10)
      .describe("Factor Q / ancho de banda (0.3–10)."),
  },
  async ({ ch, band, f, g, q }) => {
    const base = `/ch/${pad(ch)}/eq/${band}`;
    const messages: Message[] = [
      new Message(`${base}/f`, { type: "float", value: freqToOsc(f) }),
      new Message(`${base}/g`, { type: "float", value: eqGainToOsc(g) }),
      new Message(`${base}/q`, { type: "float", value: qToOsc(q) }),
    ];
    await osc.sendBundle(messages);
    return {
      content: [
        {
          type: "text",
          text:
            `EQ canal ${pad(ch)}, banda ${band}: ` +
            `f=${f}Hz → ${freqToOsc(f).toFixed(4)}, ` +
            `g=${g}dB → ${eqGainToOsc(g).toFixed(4)}, ` +
            `Q=${q} → ${qToOsc(q).toFixed(4)}`,
        },
      ],
    };
  }
);

// ─── Tool: set_dyn_comp ────────────────────────────────────────────────────

server.tool(
  "set_dyn_comp",
  "Ajusta los parámetros del compresor/gate dinámico del Fat Channel de un canal. " +
    "Umbral (thr), ratio (rat), ataque (atk en ms), release (rel en ms) y rodilla (knee). " +
    "Los valores se convierten al rango normalizado 0-1 del X32.",
  {
    ch: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada (1-32)."),
    thr: z
      .number()
      .min(-60)
      .max(0)
      .describe("Umbral del compresor en dB (−60 a 0 dB)."),
    rat: z
      .number()
      .min(1)
      .max(20)
      .describe("Ratio de compresión (1:1 a 20:1)."),
    atk: z
      .number()
      .min(0)
      .max(200)
      .describe("Tiempo de ataque en milisegundos (0–200 ms)."),
    rel: z
      .number()
      .min(0)
      .max(2000)
      .describe("Tiempo de release en milisegundos (0–2000 ms)."),
    knee: z
      .number()
      .min(0)
      .max(5)
      .describe("Suavidad de la rodilla (knee) del compresor (0–5)."),
  },
  async ({ ch, thr, rat, atk, rel, knee }) => {
    // Map parameter ranges to X32 OSC 0-1
    const thrOsc = (thr + 60) / 60;
    const ratOsc = (rat - 1) / 19;
    const atkOsc = atk / 200;
    const relOsc = rel / 2000;
    const kneeOsc = knee / 5;

    const base = `/ch/${pad(ch)}/dyn`;
    const messages: Message[] = [
      new Message(`${base}/thr`, { type: "float", value: thrOsc }),
      new Message(`${base}/rat`, { type: "float", value: ratOsc }),
      new Message(`${base}/atk`, { type: "float", value: atkOsc }),
      new Message(`${base}/rel`, { type: "float", value: relOsc }),
      new Message(`${base}/knee`, { type: "float", value: kneeOsc }),
    ];
    await osc.sendBundle(messages);
    return {
      content: [
        {
          type: "text",
          text:
            `Compresor canal ${pad(ch)}: ` +
            `thr=${thr}dB, rat=${rat}:1, atk=${atk}ms, rel=${rel}ms, knee=${knee}`,
        },
      ],
    };
  }
);

// ─── Tool: set_preamp_gain ─────────────────────────────────────────────────

server.tool(
  "set_preamp_gain",
  "Ajusta la ganancia del preamplificador de un canal y activa o desactiva la alimentación phantom (+48V). " +
    "La ganancia va de 0 a 72 dB en el X32.",
  {
    ch: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal de entrada (1-32)."),
    gain: z
      .number()
      .min(0)
      .max(72)
      .describe("Ganancia del preamplificador en dB (0–72 dB)."),
    phantom: z
      .boolean()
      .describe("true = activar alimentación phantom +48V, false = desactivar."),
  },
  async ({ ch, gain, phantom }) => {
    const base = `/ch/${pad(ch)}/preamp`;
    const gainOsc = gain / 72;
    const messages: Message[] = [
      new Message(`${base}/gain`, { type: "float", value: gainOsc }),
      new Message(`${base}/+48V`, {
        type: "integer",
        value: phantom ? 1 : 0,
      }),
    ];
    await osc.sendBundle(messages);
    return {
      content: [
        {
          type: "text",
          text: `Preamp canal ${pad(ch)}: ganancia=${gain}dB → ${gainOsc.toFixed(4)}, phantom=${phantom ? "ON" : "OFF"}`,
        },
      ],
    };
  }
);

// ─── Tool: set_matrix_send ─────────────────────────────────────────────────

server.tool(
  "set_matrix_send",
  "Ajusta el nivel de envío desde un bus de mezcla hacia una salida de matriz. " +
    "El X32 tiene 16 buses de mezcla (1-16) y 6 salidas de matriz (1-6).",
  {
    bus_source: z
      .number()
      .int()
      .min(1)
      .max(16)
      .describe("Número del bus de mezcla de origen (1-16)."),
    matrix_target: z
      .number()
      .int()
      .min(1)
      .max(6)
      .describe("Número de la salida de matriz de destino (1-6)."),
    level: z
      .number()
      .min(0)
      .max(1)
      .describe("Nivel de envío normalizado (0.0–1.0)."),
  },
  async ({ bus_source, matrix_target, level }) => {
    const path = `/bus/${pad(bus_source)}/mix/${pad(matrix_target)}/level`;
    await osc.send(new Message(path, { type: "float", value: level }));
    return {
      content: [
        {
          type: "text",
          text: `Envío del bus ${pad(bus_source)} a la matriz ${matrix_target} ajustado a ${level.toFixed(4)} (${path})`,
        },
      ],
    };
  }
);

// ─── Tool: route_input ─────────────────────────────────────────────────────

server.tool(
  "route_input",
  "Asigna una fuente de entrada física a un canal de entrada del X32. " +
    "Ejemplos de fuente: 'Local 1' (entrada analógica local 1), " +
    "'AES50 A1' (primer canal del nodo AES50-A), " +
    "'AES50 B8' (octavo canal del nodo AES50-B), " +
    "'Card 3' (tercer canal de la tarjeta de expansión).",
  {
    target_ch: z
      .number()
      .int()
      .min(1)
      .max(32)
      .describe("Número del canal destino en el X32 (1-32)."),
    source: z
      .string()
      .describe(
        "Fuente de entrada, p. ej. 'Local 1', 'AES50 A1', 'AES50 B8', 'Card 3'."
      ),
  },
  async ({ target_ch, source }) => {
    let sourceIndex: number;
    try {
      sourceIndex = resolveInputSource(source);
    } catch (err) {
      return {
        content: [{ type: "text", text: String(err) }],
        isError: true,
      };
    }
    const path = `/ch/${pad(target_ch)}/config/source`;
    await osc.send(new Message(path, { type: "integer", value: sourceIndex }));
    return {
      content: [
        {
          type: "text",
          text: `Canal ${pad(target_ch)} asignado a la fuente "${source}" (índice OSC: ${sourceIndex}, ${path})`,
        },
      ],
    };
  }
);

// ─── Main entry point ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  osc.startXRemote();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[x32-mcp] Servidor MCP iniciado. Conectando al X32 en ${X32_IP}:${X32_PORT}\n`
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`[x32-mcp] Error fatal: ${String(err)}\n`);
  process.exit(1);
});
