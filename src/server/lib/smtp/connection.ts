import { randomBytes } from "crypto";
import type { Socket } from "net";
import { PassThrough } from "stream";
import { TLSSocket } from "tls";
import { parseAddressCommand } from "./address-command";
import type { SmtpServer } from "./server";
import type { SmtpAddress, SmtpHookError, SmtpServerOptions, SmtpSession } from "./types";

const DEFAULT_SOCKET_TIMEOUT_MS = 60 * 1000;

/** Quiet time after accept during which a client that talks first is refused. */
const GREETING_DELAY_MS = 100;

/**
 * Longest command line. RFC 5321 §4.5.3.1.4 sets 512 octets for commands, but
 * an AUTH PLAIN initial response may run to RFC 4954's 12288.
 */
const MAX_LINE_BYTES = 16 * 1024;

/** RFC 5321 §4.5.3.1.8: a server must accept at least 100 recipients. */
const MAX_RECIPIENTS = 100;

const MAX_UNRECOGNIZED_COMMANDS = 10;

const HTTP_REQUEST = /^(OPTIONS|GET|HEAD|POST|PUT|DELETE|TRACE|CONNECT) \/.* HTTP\/\d\.\d$/i;

const LF = 0x0a;
const CR = 0x0d;
const DOT = 0x2e;

type LineHandler = (line: string) => Promise<void> | void;

/**
 * Turns the DATA section of the byte stream into the message: drops the
 * leading dot of a dot-stuffed line (RFC 5321 §4.5.2) and stops at the
 * `CRLF.CRLF` terminator, whose leading CRLF stays part of the message.
 */
class DotUnstuffer {
  private carry: Buffer = Buffer.alloc(0);
  private atLineStart = true;
  private afterCrlf = true;
  private previous = -1;

  /** Feeds bytes; returns the message bytes and, once the terminator is seen, what follows it. */
  feed(chunk: Buffer): { data: Buffer[]; rest?: Buffer } {
    const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk;
    this.carry = Buffer.alloc(0);
    const data: Buffer[] = [];
    let start = 0;
    let i = 0;
    while (i < buf.length) {
      const byte = buf[i];
      if (this.atLineStart && byte === DOT) {
        if (i + 1 >= buf.length) {
          if (i > start) data.push(buf.subarray(start, i));
          this.carry = Buffer.from(buf.subarray(i));
          return { data };
        }
        const next = buf[i + 1];
        if (next === DOT) {
          if (i > start) data.push(buf.subarray(start, i));
          start = i + 1;
          this.atLineStart = false;
          this.previous = DOT;
          i += 2;
          continue;
        }
        if (next === CR && this.afterCrlf) {
          if (i + 2 >= buf.length) {
            if (i > start) data.push(buf.subarray(start, i));
            this.carry = Buffer.from(buf.subarray(i));
            return { data };
          }
          if (buf[i + 2] === LF) {
            if (i > start) data.push(buf.subarray(start, i));
            return { data, rest: buf.subarray(i + 3) };
          }
        }
      }
      if (byte === LF) {
        this.atLineStart = true;
        this.afterCrlf = this.previous === CR;
      } else {
        this.atLineStart = false;
      }
      this.previous = byte;
      i++;
    }
    if (buf.length > start) data.push(buf.subarray(start));
    return { data };
  }
}

/**
 * One client connection: the command loop, AUTH, STARTTLS and the DATA
 * transfer. Commands are handled strictly one at a time; the socket is paused
 * whenever a command is waiting on a hook, the DATA consumer is not keeping
 * up, or the client is not reading its replies, so a pipelining client is held
 * by TCP backpressure rather than buffered.
 */
export class SmtpConnection {
  readonly session: SmtpSession;
  private socket: Socket;
  private secure: boolean;
  private ready = false;
  private closed = false;
  private upgrading = false;
  private busy = false;
  /** Replies are queued past the socket's high-water mark; no command runs until `drain`. */
  private replyBacklog = false;
  private pending: Buffer = Buffer.alloc(0);
  private nextHandler?: LineHandler;
  private unrecognized = 0;
  private transactionCount = 0;
  private dataStream?: PassThrough;
  private unstuffer?: DotUnstuffer;

  constructor(
    private readonly server: SmtpServer,
    socket: Socket,
    remote: { address: string; port: number; local: string; localPort: number }
  ) {
    this.socket = socket;
    this.secure = server.options.secure;
    this.session = {
      id: randomBytes(10).toString("hex"),
      remoteAddress: remote.address,
      remotePort: remote.port,
      localAddress: remote.local,
      localPort: remote.localPort,
      secure: this.secure,
      envelope: SmtpConnection.emptyEnvelope(),
      transaction: 1
    };
  }

  private static emptyEnvelope(): SmtpSession["envelope"] {
    return { mailFrom: false, rcptTo: [], bodyType: "7bit", smtpUtf8: false, requireTLS: false };
  }

  init(): void {
    this.attach(this.socket);
    if (this.server.connections.size > this.server.options.maxClients) {
      this.send(421, `${this.server.name} Too many connected clients, try again in a moment`);
      return;
    }
    const timer = setTimeout(() => {
      if (this.closed) return;
      this.ready = true;
      this.send(220, `${this.server.name} ESMTP`);
      this.pump();
    }, GREETING_DELAY_MS);
    timer.unref();
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", (err) => this.onError(err));
    socket.setTimeout(this.socketTimeout, () => this.send(421, "Timeout - closing connection"));
  }

  private get socketTimeout(): number {
    return this.server.options.socketTimeout ?? DEFAULT_SOCKET_TIMEOUT_MS;
  }

  /** Writes one reply; a multi-line reply is passed as an array of lines. */
  send(code: number, text: string | string[] = ""): void {
    const payload = Array.isArray(text)
      ? text.map((line, i) => `${code}${i < text.length - 1 ? "-" : " "}${line}`).join("\r\n")
      : text
        ? `${code} ${text}`
        : `${code} `;
    if (!this.socket.destroyed && this.socket.writable) {
      if (!this.socket.write(payload + "\r\n") && !this.replyBacklog) this.holdForDrain();
    }
    if (code === 421) this.close();
  }

  /**
   * Stops reading commands until the client has read the replies already
   * queued. A client that never reads again is dropped after the socket
   * timeout, which does not fire on its own while writes are stuck.
   */
  private holdForDrain(): void {
    this.replyBacklog = true;
    const socket = this.socket;
    socket.pause();
    const stalled = setTimeout(() => socket.destroy(), this.socketTimeout);
    const clearStall = () => clearTimeout(stalled);
    socket.once("close", clearStall);
    socket.once("drain", () => {
      clearTimeout(stalled);
      socket.off("close", clearStall);
      if (this.socket !== socket) return;
      this.replyBacklog = false;
      if (this.closed || this.upgrading || this.busy) return;
      if (this.unstuffer) {
        if (!this.dataStream?.writableNeedDrain) socket.resume();
        return;
      }
      socket.resume();
      this.pump();
    });
  }

  close(): void {
    if (!this.socket.destroyed && this.socket.writable) this.socket.end();
    this.server.connections.delete(this);
  }

  private onData(chunk: Buffer): void {
    if (this.closed || this.upgrading) return;
    if (this.unstuffer) {
      this.feedData(chunk);
      return;
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (this.busy && this.pending.length > MAX_LINE_BYTES) this.socket.pause();
    this.pump();
  }

  /** Runs buffered command lines until one has to wait. */
  private pump(): void {
    while (!this.busy && !this.closed && !this.upgrading && !this.unstuffer && !this.replyBacklog) {
      const lf = this.pending.indexOf(LF);
      if (lf === -1) {
        if (this.pending.length > MAX_LINE_BYTES) {
          this.pending = Buffer.alloc(0);
          this.send(421, "Error: line too long");
        }
        break;
      }
      const end = lf > 0 && this.pending[lf - 1] === CR ? lf - 1 : lf;
      const line = this.pending.subarray(0, end).toString("utf8");
      this.pending = this.pending.subarray(lf + 1);
      if (end > MAX_LINE_BYTES) {
        this.send(421, "Error: line too long");
        break;
      }
      const result = this.handleLine(line);
      if (result instanceof Promise) {
        this.busy = true;
        this.socket.pause();
        result
          .catch((err) => this.onError(err as Error))
          .finally(() => {
            this.busy = false;
            if (!this.unstuffer && !this.upgrading && !this.replyBacklog) this.socket.resume();
            this.pump();
          });
      }
    }
  }

  private handleLine(line: string): Promise<void> | void {
    const command = line.split(" ")[0].toUpperCase();

    if (this.server.isClosing) return this.send(421, "Server shutting down");
    if (!this.ready) return this.send(421, `${this.server.name} You talk too soon`);
    if (HTTP_REQUEST.test(line)) return this.send(421, "HTTP requests not allowed");

    if (this.nextHandler) {
      const handler = this.nextHandler;
      this.nextHandler = undefined;
      return handler(line);
    }

    const handler = this.handlers[command];
    if (!handler) {
      this.unrecognized++;
      if (this.unrecognized >= MAX_UNRECOGNIZED_COMMANDS) {
        return this.send(421, "Error: too many unrecognized commands");
      }
      return this.send(500, "Error: command not recognized");
    }

    if (!this.session.hostNameAppearsAs && ["MAIL", "RCPT", "DATA", "AUTH"].includes(command)) {
      return this.send(503, "Error: send HELO/EHLO first");
    }

    return handler(line);
  }

  private readonly handlers: Record<string, LineHandler> = {
    EHLO: (line) => this.ehlo(line),
    HELO: (line) => this.helo(line),
    QUIT: () => {
      this.send(221, "Bye");
      this.close();
    },
    NOOP: () => this.send(250, "OK"),
    RSET: () => {
      this.resetEnvelope();
      this.send(250, "Flushed");
    },
    HELP: () => this.send(214, "See https://tools.ietf.org/html/rfc5321 for details"),
    VRFY: () => this.send(252, "Try to send something. No promises though"),
    STARTTLS: () => this.startTls(),
    AUTH: (line) => this.auth(line),
    MAIL: (line) => this.mail(line),
    RCPT: (line) => this.rcpt(line),
    DATA: () => this.data()
  };

  private resetEnvelope(): void {
    this.session.envelope = SmtpConnection.emptyEnvelope();
    this.session.transaction = this.transactionCount + 1;
  }

  private greetingLine(): string {
    return `${this.server.name} Nice to meet you, [${this.session.remoteAddress}]`;
  }

  private ehlo(line: string): void {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) return this.send(501, "Error: syntax: EHLO hostname");
    this.session.hostNameAppearsAs = parts[1].toLowerCase();

    const features = ["PIPELINING", "8BITMIME", "SMTPUTF8"];
    if (!this.session.user) features.push("AUTH LOGIN PLAIN");
    if (!this.secure && this.server.tlsAvailable) features.push("STARTTLS");
    features.push(`SIZE ${this.server.options.size}`);

    this.resetEnvelope();
    this.send(250, [this.greetingLine(), ...features]);
  }

  private helo(line: string): void {
    const parts = line.trim().split(/\s+/);
    if (parts.length !== 2) return this.send(501, "Error: Syntax: HELO hostname");
    this.session.hostNameAppearsAs = parts[1].toLowerCase();
    this.resetEnvelope();
    this.send(250, this.greetingLine());
  }

  private startTls(): void {
    if (this.secure) return this.send(503, "Error: TLS already active");
    const secureContext = this.server.secureContext;
    if (!secureContext) return this.send(454, "Error: TLS not available");

    this.send(220, "Ready to start TLS");
    // Anything pipelined after STARTTLS arrived in cleartext and must not be
    // read as if it came over the encrypted channel (RFC 3207 §4.2).
    this.pending = Buffer.alloc(0);
    this.upgrading = true;

    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    plain.removeAllListeners("timeout");
    plain.setTimeout(0);
    plain.on("error", (err) => this.onError(err));

    const secureSocket = new TLSSocket(plain, { isServer: true, secureContext });
    const onHandshakeError = (err?: Error) => {
      this.onError(this.server.handshakeError(err, this.session.remoteAddress));
    };
    const onHandshakeClose = () => this.onClose();
    const onHandshakeTimeout = () => secureSocket.destroy();
    secureSocket.once("error", onHandshakeError);
    secureSocket.once("close", onHandshakeClose);
    secureSocket.setTimeout(this.socketTimeout, onHandshakeTimeout);
    secureSocket.once("secure", () => {
      secureSocket.removeListener("error", onHandshakeError);
      secureSocket.removeListener("close", onHandshakeClose);
      secureSocket.removeListener("timeout", onHandshakeTimeout);
      this.socket = secureSocket;
      this.secure = true;
      this.session.secure = true;
      // RFC 3207 §4.2: nothing learned before the handshake carries over.
      this.session.hostNameAppearsAs = undefined;
      this.session.user = undefined;
      this.resetEnvelope();
      this.upgrading = false;
      this.replyBacklog = false;
      this.attach(secureSocket);
    });
  }

  private auth(line: string): Promise<void> | void {
    const args = line.trim().split(/\s+/);
    args.shift();
    const method = (args.shift() ?? "").toUpperCase();

    if (!this.secure && !this.server.options.allowInsecureAuth) {
      return this.send(538, "Error: Must issue a STARTTLS command first");
    }
    if (this.session.user) return this.send(503, "Error: No identity changes permitted");

    if (method === "PLAIN") {
      if (args.length > 1) return this.send(501, "Error: syntax: AUTH PLAIN token");
      if (!args.length) {
        this.nextHandler = (token) => this.authPlain(token, true);
        return this.send(334);
      }
      return this.authPlain(args[0], false);
    }
    if (method === "LOGIN") {
      if (args.length > 1) return this.send(501, "Error: syntax: AUTH LOGIN");
      if (!args.length) {
        this.nextHandler = (username) => this.authLoginUsername(username, true);
        return this.send(334, "VXNlcm5hbWU6");
      }
      return this.authLoginUsername(args[0], false);
    }
    return this.send(504, "Error: Unrecognized authentication type");
  }

  private authPlain(token: string, canAbort: boolean): Promise<void> | void {
    const trimmed = token.trim();
    if (canAbort && trimmed === "*") return this.send(501, "Authentication aborted");
    const fields = Buffer.from(trimmed, "base64").toString().split("\x00");
    if (fields.length !== 3) return this.send(500, "Error: invalid userdata");
    return this.authenticate("PLAIN", fields[1] || fields[0] || "", fields[2] || "");
  }

  private authLoginUsername(token: string, canAbort: boolean): void {
    const trimmed = token.trim();
    if (canAbort && trimmed === "*") return this.send(501, "Authentication aborted");
    const username = Buffer.from(trimmed, "base64").toString();
    if (!username) return this.send(500, "Error: missing username");
    this.nextHandler = (password) => this.authLoginPassword(username, password);
    this.send(334, "UGFzc3dvcmQ6");
  }

  private authLoginPassword(username: string, token: string): Promise<void> | void {
    const trimmed = token.trim();
    if (trimmed === "*") return this.send(501, "Authentication aborted");
    return this.authenticate("LOGIN", username, Buffer.from(trimmed, "base64").toString());
  }

  private authenticate(
    method: "PLAIN" | "LOGIN",
    username: string,
    password: string
  ): Promise<void> {
    return new Promise((resolve) => {
      this.server.options.onAuth({ method, username, password }, this.session, (err, response) => {
        if (err) this.send(err.responseCode || 535, err.message);
        else if (!response?.user) {
          this.send(
            response?.responseCode || 535,
            response?.message || "Error: Authentication credentials invalid"
          );
        } else {
          this.session.user = response.user;
          this.send(235, "Authentication successful");
        }
        resolve();
      });
    });
  }

  private mail(line: string): Promise<void> | void {
    const parsed = parseAddressCommand("mail from", line);
    if (!parsed) return this.send(501, "Error: Bad sender address syntax");
    if (this.session.envelope.mailFrom) return this.send(503, "Error: nested MAIL command");

    const args = parsed.args || {};
    const { size } = this.server.options;
    if (args.SIZE && Number(args.SIZE) > size) {
      return this.send(552, `Error: message exceeds fixed maximum message size ${size}`);
    }
    if (args.BODY) {
      const body = String(args.BODY).toLowerCase();
      if (body !== "7bit" && body !== "8bitmime") {
        return this.send(501, "Invalid BODY parameter value. Must be 7BIT or 8BITMIME");
      }
    }
    if (args.SMTPUTF8 !== undefined && args.SMTPUTF8 !== true) {
      return this.send(501, "Invalid SMTPUTF8 parameter. This flag does not accept a value");
    }
    if (args.REQUIRETLS !== undefined) {
      if (!this.secure) return this.send(530, "REQUIRETLS not permitted on non-TLS connections");
      if (args.REQUIRETLS !== true) {
        return this.send(501, "Invalid REQUIRETLS parameter. This flag does not accept a value");
      }
    }

    const envelope = this.session.envelope;
    if (args.BODY) envelope.bodyType = String(args.BODY).toLowerCase();
    if (args.SMTPUTF8 === true) envelope.smtpUtf8 = true;
    if (args.REQUIRETLS === true) envelope.requireTLS = true;

    return this.runHook(this.server.options.onMailFrom, parsed, (err) => {
      if (err) return this.send(err.responseCode || 550, err.message);
      this.session.envelope.mailFrom = parsed;
      this.send(250, "Accepted");
    });
  }

  private rcpt(line: string): Promise<void> | void {
    const parsed = parseAddressCommand("rcpt to", line);
    if (!parsed || !parsed.address) return this.send(501, "Error: Bad recipient address syntax");
    if (!this.session.envelope.mailFrom) return this.send(503, "Error: need MAIL command");

    const recipients = this.session.envelope.rcptTo;
    const isRepeat = recipients.some(
      (entry) => entry.address.toLowerCase() === parsed.address.toLowerCase()
    );
    if (!isRepeat && recipients.length >= MAX_RECIPIENTS) {
      return this.send(452, "Error: too many recipients");
    }

    return this.runHook(this.server.options.onRcptTo, parsed, (err) => {
      if (err) return this.send(err.responseCode || 550, err.message);
      const list = this.session.envelope.rcptTo;
      const index = list.findIndex(
        (entry) => entry.address.toLowerCase() === parsed.address.toLowerCase()
      );
      if (index >= 0) list[index] = parsed;
      else list.push(parsed);
      this.send(250, "Accepted");
    });
  }

  private runHook(
    hook: SmtpServerOptions["onMailFrom"],
    address: SmtpAddress,
    done: (err?: SmtpHookError | null) => void
  ): Promise<void> {
    return new Promise((resolve) => {
      hook(address, this.session, (err) => {
        done(err);
        resolve();
      });
    });
  }

  private data(): void {
    if (!this.session.envelope.rcptTo.length) return this.send(503, "Error: need RCPT command");

    const stream = new PassThrough();
    stream.on("drain", () => {
      if (this.dataStream === stream && this.unstuffer && !this.closed && !this.replyBacklog) {
        this.socket.resume();
      }
    });
    this.dataStream = stream;
    this.unstuffer = new DotUnstuffer();

    let answer: { err?: SmtpHookError | null } | undefined;
    let ended = false;
    const reply = () => {
      if (!answer || !ended || this.closed) return;
      const { err } = answer;
      answer = undefined;
      if (err) this.send(err.responseCode || 450, err.message);
      else this.send(250, "OK: message queued");
      this.finishTransaction();
    };
    stream.once("end", () => {
      ended = true;
      reply();
    });

    this.server.options.onData(stream, this.session, (err) => {
      if (answer || this.dataStream !== stream) return;
      answer = { err };
      ended ||= stream.readableEnded;
      reply();
    });

    this.send(354, "End data with <CR><LF>.<CR><LF>");

    // Bytes that followed the DATA line in the same read are message content.
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    if (rest.length) this.feedData(rest);
  }

  private feedData(chunk: Buffer): void {
    const stream = this.dataStream;
    const unstuffer = this.unstuffer;
    if (!stream || !unstuffer) return;
    const { data, rest } = unstuffer.feed(chunk);
    let flowing = true;
    for (const piece of data) {
      if (!stream.writableEnded) flowing = stream.write(piece) && flowing;
    }
    if (rest !== undefined) {
      this.unstuffer = undefined;
      // Commands pipelined behind the message wait for its reply.
      this.pending = Buffer.from(rest);
      this.busy = true;
      this.socket.pause();
      stream.end();
      return;
    }
    if (!flowing) this.socket.pause();
  }

  private finishTransaction(): void {
    this.dataStream = undefined;
    this.transactionCount++;
    this.unrecognized = 0;
    this.resetEnvelope();
    this.busy = false;
    if (!this.closed && !this.replyBacklog) {
      this.socket.resume();
      this.pump();
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.server.connections.delete(this);
    const stream = this.dataStream;
    this.dataStream = undefined;
    this.unstuffer = undefined;
    // A transfer cut off mid-DATA ends without an `end`, which is how the
    // consumer tells an abandoned message from a complete one.
    if (stream && !stream.writableEnded) stream.destroy();
  }

  private onError(err: Error & { code?: string; remoteAddress?: string }): void {
    err.remoteAddress = this.session.remoteAddress;
    const quietCodes = err.code === "ECONNRESET" || err.code === "EPIPE";
    if (quietCodes && !this.session.envelope.mailFrom) {
      // A client dropping the connection outside a transaction is how most
      // sessions end; nothing was accepted, so nothing is reported.
      this.close();
      return;
    }
    this.server.emit("error", err);
  }
}
