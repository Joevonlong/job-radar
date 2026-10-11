import net from "node:net";

/**
 * A tiny in-process IMAP server (loopback, no network): just enough of the protocol for imapflow to
 * log in, open one mailbox, search and fetch. It records every command, so tests can prove the
 * channel only ever sends read-only commands.
 */
export interface FakeImapMessage {
  uid: number;
  messageId: string | null;
  from: string;
  subject: string;
  date: Date;
  source: Buffer;
}

export interface FakeImapServer {
  port: number;
  /** Every tagged command line received after login, e.g. `EXAMINE "JobAlerts"`. */
  commands: string[];
  logins: number;
  close(): Promise<void>;
}

const quote = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&")}"`;

function envelope(m: FakeImapMessage): string {
  const [local = "", host = ""] = m.from.split("@");
  const address = `((NIL NIL ${quote(local)} ${quote(host)}))`;
  const id = m.messageId ? quote(m.messageId) : "NIL";
  return `(${quote(m.date.toUTCString())} ${quote(m.subject)} ${address} ${address} ${address} NIL NIL NIL NIL ${id})`;
}

function internalDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export async function startFakeImapServer(options: { mailbox: string; messages: readonly FakeImapMessage[]; password?: string }): Promise<FakeImapServer> {
  const commands: string[] = [];
  const state = { logins: 0 };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = "";
    socket.write("* OK IMAP4rev1 fake ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\r\n");
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        handle(socket, line);
      }
    });
  });

  function handle(socket: net.Socket, line: string): void {
    const space = line.indexOf(" ");
    const tag = line.slice(0, space);
    const rest = line.slice(space + 1);
    const [verbRaw = "", ...args] = rest.split(" ");
    const verb = verbRaw.toUpperCase();
    const ok = (text = "done"): void => void socket.write(`${tag} OK ${text}\r\n`);

    if (verb === "CAPABILITY") {
      socket.write("* CAPABILITY IMAP4rev1 ID NAMESPACE UIDPLUS\r\n");
      return ok();
    }
    if (verb === "LOGIN") {
      const password = args[1]?.replace(/^"|"$/g, "");
      if (options.password !== undefined && password !== options.password) {
        socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        return;
      }
      state.logins += 1;
      return ok("[CAPABILITY IMAP4rev1 ID NAMESPACE UIDPLUS] logged in");
    }
    commands.push(rest);
    switch (verb) {
      case "ID":
        socket.write("* ID NIL\r\n");
        return ok();
      case "NAMESPACE":
        socket.write('* NAMESPACE (("" "/")) NIL NIL\r\n');
        return ok();
      case "LIST":
        socket.write(`* LIST (\\HasNoChildren) "/" ${quote(options.mailbox)}\r\n`);
        return ok();
      case "ENABLE":
      case "NOOP":
        return ok();
      case "EXAMINE":
      case "SELECT": {
        const name = rest.slice(verbRaw.length + 1).replace(/^"|"$/g, "");
        if (name !== options.mailbox) {
          socket.write(`${tag} NO [NONEXISTENT] Unknown Mailbox\r\n`);
          return;
        }
        socket.write(`* ${options.messages.length} EXISTS\r\n* 0 RECENT\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${options.messages.length + 1}] ok\r\n* FLAGS (\\Seen \\Answered)\r\n`);
        return ok(verb === "EXAMINE" ? "[READ-ONLY] EXAMINE completed" : "[READ-WRITE] SELECT completed");
      }
      case "UID": {
        const sub = (args[0] ?? "").toUpperCase();
        if (sub === "SEARCH") {
          socket.write(`* SEARCH ${options.messages.map((m) => m.uid).join(" ")}\r\n`);
          return ok("SEARCH completed");
        }
        if (sub === "FETCH") {
          const wanted = new Set((args[1] ?? "").split(",").flatMap((part) => {
            const [a, b] = part.split(":").map(Number);
            return b === undefined ? [a] : Array.from({ length: (b as number) - (a as number) + 1 }, (_, i) => (a as number) + i);
          }));
          const items = rest.slice(rest.indexOf("(")).toUpperCase();
          options.messages.forEach((m, index) => {
            if (!wanted.has(m.uid)) return;
            if (items.includes("BODY.PEEK[]") || items.includes("BODY[]")) {
              socket.write(`* ${index + 1} FETCH (UID ${m.uid} BODY[] {${m.source.length}}\r\n`);
              socket.write(m.source);
              socket.write(")\r\n");
            } else {
              socket.write(`* ${index + 1} FETCH (UID ${m.uid} INTERNALDATE ${quote(internalDate(m.date))} ENVELOPE ${envelope(m)})\r\n`);
            }
          });
          return ok("FETCH completed");
        }
        socket.write(`${tag} BAD unsupported\r\n`);
        return;
      }
      case "CLOSE":
      case "UNSELECT":
        return ok();
      case "LOGOUT":
        socket.write("* BYE bye\r\n");
        ok();
        socket.end();
        return;
      default:
        // anything else (STORE, COPY, MOVE, EXPUNGE, APPEND, DELETE, ...) is refused, but recorded above
        socket.write(`${tag} NO [CANNOT] refused by the fake server\r\n`);
    }
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake imap server has no port");
  return {
    port: address.port,
    commands,
    get logins() {
      return state.logins;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
