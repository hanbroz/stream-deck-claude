/**
 * Terminal PTY shapes. The project terminal still uses a long-lived node-pty
 * process; the Claude runner no longer does, so these types live on their own.
 */
export type PtyLike = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtyFactory = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
  }
) => PtyLike;
