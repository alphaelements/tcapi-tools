/**
 * A fake device for tests that need an unbounded number of exchanges (the
 * watchdog heartbeat, safety state read-back). The response shapes come from
 * the golden transcripts: the `version` handshake and the `ping` echo are
 * taken from `version-info.txt`; everything else is answered by the handler a
 * test supplies from golden-derived lines.
 */
import { FakePort } from "./fake-port.js";
import { goldenCase, goldenResponse } from "./golden.js";

const HANDSHAKE = goldenResponse(goldenCase("version-info", "version"), "version");
const PONG_TEMPLATE = goldenResponse(goldenCase("version-info", "ping echoes the u32"), "ping 12345")[0];
const PONG_PATTERN = "12345";

/** The golden answer to `ping <n>`. */
export function pongFor(n: number): string {
  return PONG_TEMPLATE.replace(PONG_PATTERN, String(n));
}

export type Handler = (cmd: string) => string[] | undefined;

export class EchoPort extends FakePort {
  /** Every command line the host wrote, in order. */
  readonly commands: string[] = [];
  /** Answer `ping` with this (default: the golden echo); `[]` stays silent. */
  pingReply: ((n: number) => string[]) | null = null;

  constructor(private readonly handler: Handler = () => undefined) {
    super();
    this.onCommand = (cmd) => {
      this.commands.push(cmd);
      const reply = this.reply(cmd);
      if (reply.length > 0) this.feed(...reply);
    };
  }

  private reply(cmd: string): string[] {
    if (cmd === "version") return HANDSHAKE;
    const ping = /^ping (\d+)$/.exec(cmd);
    if (ping !== null) {
      const n = Number(ping[1]);
      return this.pingReply === null ? [pongFor(n)] : this.pingReply(n);
    }
    return this.handler(cmd) ?? ["ERR UNKNOWN_CMD"];
  }

  /** The `ping` lines the host wrote. */
  pings(): string[] {
    return this.commands.filter((c) => c.startsWith("ping "));
  }
}
