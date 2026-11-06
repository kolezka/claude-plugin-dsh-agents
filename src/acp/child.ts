import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config";

const maxLogBytes = 64 * 1024;
const expectedWarning = (line: string) => /\b(?:ui-settings-general|ui-chat|ui-theme)\b.*\bnot found\b/.test(line);

export function redactDiagnostic(text: string): string {
  return text
    .replace(/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, "$1<REDACTED>")
    .replace(/(\b(?:x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1<REDACTED>")
    .replace(/(--(?:token|api-key|access-token|secret)(?:=|\s+))("[^"]*"|'[^']*'|[^\s]+)/gi, "$1<REDACTED>")
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 <REDACTED>");
}

async function finishedWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
  finally { clearTimeout(timer!); }
}

export class DshChild {
  private process?: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private started?: Promise<{ stream: Stream }>;
  private stopping?: Promise<void>;
  private stderr = "";
  private stderrDone?: Promise<void>;
  private exitResolve!: (code: number) => void;
  readonly exited = new Promise<number>(resolve => { this.exitResolve = resolve; });

  constructor(private cfg: Pick<Config, "dshBin" | "profile" | "patches" | "stateDir">, private log: (line: string) => void) {}

  start(): Promise<{ stream: Stream }> {
    return this.started ??= this.launch().catch(error => { this.exitResolve(-1); throw error; });
  }

  private async launch(): Promise<{ stream: Stream }> {
    await mkdir(this.cfg.stateDir, { recursive: true, mode: 0o700 });
    const file = await open(join(this.cfg.stateDir, `dsh-${crypto.randomUUID()}.stderr.log`), "wx", 0o600);
    let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
    try { child = Bun.spawn([this.cfg.dshBin, "--profile", this.cfg.profile, ...this.cfg.patches.flatMap(patch => ["--patch", patch])], { stdin: "pipe", stdout: "pipe", stderr: "pipe" }); }
    catch (error) { await file.close(); this.exitResolve(-1); throw error; }
    this.process = child;
    void child.exited.then(code => this.exitResolve(code));
    this.stderrDone = (async () => {
      const decoder = new TextDecoder();
      let partial = "";
      let discarding = false;
      const persist = async (text: string) => {
        this.stderr = (this.stderr + redactDiagnostic(text)).slice(-maxLogBytes);
        const bounded = Buffer.from(this.stderr).subarray(-maxLogBytes);
        await file.truncate(0);
        await file.write(bounded, 0, bounded.length, 0);
      };
      try {
        for await (const bytes of child.stderr) {
          let text = decoder.decode(bytes, { stream: true });
          if (discarding) {
            const end = text.indexOf("\n");
            if (end < 0) continue;
            text = text.slice(end + 1); discarding = false;
          }
          partial += text;
          const end = partial.lastIndexOf("\n");
          if (end >= 0) { await persist(partial.slice(0, end + 1)); partial = partial.slice(end + 1); }
          // Never persist a partial header or token split across pipe chunks.
          if (partial.length > maxLogBytes) {
            partial = ""; discarding = true;
            await persist("[oversized stderr line omitted]\n");
          }
        }
        partial += decoder.decode();
        if (partial && !discarding) await persist(partial);
      } finally { await file.close(); }
    })();
    void this.stderrDone.catch(() => this.log("dsh stderr capture failed"));
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const encoder = new TextEncoder();
    const filter = new TransformStream<Uint8Array, Uint8Array>({
      transform: (bytes, controller) => {
        buffer += decoder.decode(bytes, { stream: true });
        if (buffer.length > 1024 * 1024 && !buffer.includes("\n")) throw new Error("dsh stdout line exceeds limit");
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let value: unknown;
          try { value = JSON.parse(line); } catch { this.log("dsh stdout dropped non-object line"); continue; }
          if (value === null || typeof value !== "object" || Array.isArray(value)) { this.log("dsh stdout dropped non-object line"); continue; }
          controller.enqueue(encoder.encode(line + "\n"));
        }
      },
      flush: () => { buffer += decoder.decode(); if (buffer.trim()) throw new Error("dsh stdout ended mid-frame"); },
    });
    const output = new WritableStream<Uint8Array>({
      write: async bytes => { child.stdin.write(bytes); await child.stdin.flush(); },
      close: () => { child.stdin.end(); },
      abort: () => { child.stdin.end(); },
    });
    return { stream: ndJsonStream(output, child.stdout.pipeThrough(filter)) };
  }

  lastStderrLines(n: number): string[] {
    if (n <= 0) return [];
    return this.stderr.split(/\r?\n/).filter(line => line && !expectedWarning(line)).slice(-Math.max(0, n));
  }

  shutdown(): Promise<void> {
    return this.stopping ??= this.stop();
  }

  private async stop(): Promise<void> {
    if (!this.started) return;
    try { await this.started; }
    catch (error) { if (!this.process) return; throw error; }
    const child = this.process!;
    child.stdin.end();
    if (!await finishedWithin(child.exited, 5000)) {
      child.kill("SIGTERM");
      if (!await finishedWithin(child.exited, 2000)) child.kill("SIGKILL");
    }
    await child.exited;
    await this.stderrDone;
  }
}
