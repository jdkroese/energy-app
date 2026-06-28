// Rain Bird SIP (Sprinkler Irrigation Protocol) command codec — a TypeScript port
// of pyrainbird/rainbird.py + pyrainbird/resources/sipcommands.yaml, restricted to
// the Phase-1 command set. Every command is a hex string: a 1-byte command code
// followed by fixed-width hex fields. Responses are decoded by slicing the hex
// string at documented (position, length) offsets — positions/lengths are in HEX
// NIBBLES (one hex char), exactly as the YAML defines them.
//
// Verified against pyrainbird test vectors (see encryption.test.ts / sip.test.ts):
//   ModelAndVersion response "820006090C" → model 0x0006, ver 9.12
//   AvailableStations    "83003F000000"   → page 0, mask 0x3F000000 (stations 1-6)
//   CurrentStationsActive"BF...mask"       → same mask layout as AvailableStations
//   CurrentIrrigationState "C801"          → state 1 (on)
//   RainDelay            "B6000E"          → 14 days
//   SerialNumber         "850000000000008963"
//
// Opcode table (from sipcommands.yaml). Field positions are HEX-CHAR offsets.

export interface CommandSpec {
  /** Request command code (hex, 2 chars). */
  command: string;
  /** Total request length in BYTES (so hex string length = length*2). */
  length: number;
  /** Expected response command code (hex), for sanity-checking. */
  response: string;
}

/** The Phase-1 request commands. */
export const REQUESTS = {
  ModelAndVersion: { command: "02", length: 1, response: "82" },
  AvailableStations: { command: "03", length: 2, response: "83" },
  CurrentIrrigationState: { command: "48", length: 1, response: "C8" },
  CurrentStationsActive: { command: "3F", length: 2, response: "BF" },
  ManuallyRunStation: { command: "39", length: 4, response: "01" },
  StopIrrigation: { command: "40", length: 1, response: "01" },
  RainDelayGet: { command: "36", length: 1, response: "B6" },
  RainDelaySet: { command: "37", length: 3, response: "01" },
  SerialNumber: { command: "05", length: 1, response: "85" },
} as const satisfies Record<string, CommandSpec>;

export type RequestName = keyof typeof REQUESTS;

/**
 * Encode a SIP request to its hex string. The first byte is the command code; any
 * arguments are appended as fixed-width hex, padded with leading zeros so the total
 * occupies `length` bytes. This mirrors pyrainbird's `encode_command` for the
 * "parameter"/"parameterOne"/fixed-length style commands in our Phase-1 set:
 *
 *   - AvailableStations(page)            → "03" + page(2 hex)            len 2
 *   - CurrentStationsActive(mask page=0) → "3F" + page(2 hex)            len 2
 *   - ManuallyRunStation(station, mins)  → "39" + station(2) + mins(4)   len 4
 *   - RainDelaySet(days)                 → "37" + days(4 hex)            len 3
 *   - 1-byte commands take no args.
 *
 * pyrainbird builds these by laying each arg into the zero-filled buffer at the
 * documented position; for our commands that is equivalent to concatenating the
 * args left-to-right after the command byte, then right-zero-padding to `length`.
 */
export function encode(name: RequestName, args: number[] = []): string {
  const spec = REQUESTS[name];
  // Lay the args into the command body using each command's documented field widths.
  const body = encodeFields(name, args);
  const total = spec.length * 2;
  let data = spec.command + body;
  if (data.length > total) {
    throw new Error(
      `rainbird encode ${name}: args overflow command length (${data.length} > ${total})`,
    );
  }
  // Right-pad with zeros to the documented command length.
  data = data.padEnd(total, "0");
  return data.toUpperCase();
}

/** Field widths (in hex chars) per command, after the command byte. */
function encodeFields(name: RequestName, args: number[]): string {
  switch (name) {
    case "AvailableStations":
    case "CurrentStationsActive": {
      // page (1 byte). Default page 0 when omitted.
      const page = args[0] ?? 0;
      return toHex(page, 2);
    }
    case "ManuallyRunStation": {
      // station (1 byte) + minutes (2 bytes).
      const station = req(args, 0, name);
      const minutes = req(args, 1, name);
      return toHex(station, 2) + toHex(minutes, 4);
    }
    case "RainDelaySet": {
      // days (2 bytes).
      const days = req(args, 0, name);
      return toHex(days, 4);
    }
    default:
      return ""; // 1-byte commands have no payload
  }
}

function req(args: number[], i: number, name: string): number {
  const v = args[i];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`rainbird encode ${name}: missing numeric arg #${i}`);
  }
  return Math.max(0, Math.round(v));
}

/** Unsigned int → zero-padded uppercase hex of exactly `chars` nibbles. */
function toHex(n: number, chars: number): string {
  const h = Math.max(0, Math.round(n)).toString(16);
  if (h.length > chars)
    throw new Error(`rainbird: value 0x${h} exceeds ${chars} hex chars`);
  return h.padStart(chars, "0").toUpperCase();
}

/** Slice an unsigned int field out of a hex response string at [pos, pos+len) nibbles. */
function field(hex: string, pos: number, len: number): number {
  return parseInt(hex.substring(pos, pos + len), 16);
}

// ---- Response decoders ------------------------------------------------------
// Positions/lengths are HEX-CHAR offsets straight from sipcommands.yaml.

export interface ModelAndVersion {
  modelId: number;
  versionMajor: number;
  versionMinor: number;
  /** "major.minor" convenience string. */
  version: string;
}

export function decodeModelAndVersion(hex: string): ModelAndVersion {
  const h = hex.toUpperCase();
  const major = field(h, 6, 2);
  const minor = field(h, 8, 2);
  return {
    modelId: field(h, 2, 4),
    versionMajor: major,
    versionMinor: minor,
    version: `${major}.${minor}`,
  };
}

export interface StationsMask {
  page: number;
  /** Raw 32-bit mask (e.g. 0x3F000000). */
  mask: number;
  /** 1-based station numbers that are set, LSB-first within each byte. */
  stations: number[];
}

/** Decode a stations bitmask response (shared by AvailableStations + CurrentStationsActive).
 *  pyrainbird's `States` parses the mask byte-by-byte, LSB-first within each byte:
 *  for hex "3F000000" the first byte 0x3F → bits 0..5 → stations 1..6. */
export function decodeStations(hex: string): StationsMask {
  const h = hex.toUpperCase();
  const page = field(h, 2, 2);
  const maskHex = h.substring(4, 12); // 8 hex chars = 4 bytes
  const mask = parseInt(maskHex, 16) >>> 0;
  const stations: number[] = [];
  let station = 0;
  for (let i = 0; i < maskHex.length; i += 2) {
    const byte = parseInt(maskHex.substring(i, i + 2), 16);
    for (let bit = 0; bit < 8; bit++) {
      station++;
      if (byte & (1 << bit)) stations.push(station);
    }
  }
  return { page, mask, stations };
}

/** CurrentIrrigationState → boolean (1 = irrigation system on/active). */
export function decodeIrrigationState(hex: string): boolean {
  return field(hex.toUpperCase(), 2, 2) === 1;
}

/** RainDelayGet → number of delay days remaining. */
export function decodeRainDelay(hex: string): number {
  return field(hex.toUpperCase(), 2, 4);
}

/** SerialNumber → hex string of the serial (16 nibbles). */
export function decodeSerialNumber(hex: string): string {
  const h = hex.toUpperCase();
  return h.substring(2, 2 + 16);
}

/** The command code (first byte) of a response hex string. */
export function responseCode(hex: string): string {
  return hex.substring(0, 2).toUpperCase();
}
