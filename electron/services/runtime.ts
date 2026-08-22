/**
 * First-run audio runtime setup.
 *
 * Sipra ships a small installer and builds its own private Python
 * environment the first time it launches. The alternative — bundling
 * PyTorch — makes a 2-3 GB installer that has to be re-downloaded in full
 * every time a model or a dependency moves.
 *
 * Order of preference for creating the environment:
 *   1. a bundled `uv` binary in the app's resources
 *   2. `uv` already on the user's PATH
 *   3. `uv` downloaded from its GitHub release
 *   4. a system Python 3.10+ with the stdlib `venv` module
 *
 * `uv` is preferred because it installs a pinned CPython itself, so the
 * result does not depend on whatever Python the user happens to have.
 *
 * Everything that touches a real process goes through `ProcessRunner`, so
 * the whole state machine can be tested without spawning anything.
 */

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { RuntimeStatus, SipraErrorPayload } from '../../shared/types';

export const UV_VERSION = '0.4.30';
export const PYTHON_VERSION = '3.11';

/** Minimum system Python we will fall back to. */
export const MIN_PYTHON = [3, 10] as const;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  onOutput?: (chunk: string) => void;
}

export interface ProcessRunner {
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult>;
  exists(filePath: string): Promise<boolean>;
  which(command: string): Promise<string | null>;
}

export class NodeProcessRunner implements ProcessRunner {
  async run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      const timer = options.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`'${command}' timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs)
        : null;

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        options.onOutput?.(chunk);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        options.onOutput?.(chunk);
      });

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async which(command: string): Promise<string | null> {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
      const result = await this.run(finder, [command], { timeoutMs: 8000 });
      if (result.code !== 0) return null;
      const first = result.stdout.split(/\r?\n/).find((line) => line.trim());
      return first ? first.trim() : null;
    } catch {
      return null;
    }
  }
}

export interface RuntimeManagerOptions {
  /** Where the private environment lives (under userData). */
  runtimeDir: string;
  /** Directory containing the `sipra_core` package. */
  corePath: string;
  /** Directory holding bundled binaries (uv, ffmpeg, yt-dlp). */
  binDir: string;
  /** Directory holding the pinned requirements files. */
  requirementsDir: string;
  runner?: ProcessRunner;
  /** Skip the GPU probe and install the CPU build of PyTorch. */
  forceCpu?: boolean;
}

export function venvPythonPath(runtimeDir: string, platform: string = process.platform): string {
  return platform === 'win32'
    ? path.join(runtimeDir, 'venv', 'Scripts', 'python.exe')
    : path.join(runtimeDir, 'venv', 'bin', 'python');
}

export function uvBinaryName(platform: string = process.platform): string {
  return platform === 'win32' ? 'uv.exe' : 'uv';
}

/** Parse `Python 3.11.9` into `[3, 11, 9]`. */
export function parsePythonVersion(output: string): [number, number, number] | null {
  const match = /Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i.exec(output);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

export function meetsMinimumPython(version: readonly number[] | null): boolean {
  if (!version || version.length < 2) return false;
  const [major = 0, minor = 0] = version;
  if (major !== MIN_PYTHON[0]) return major > MIN_PYTHON[0];
  return minor >= MIN_PYTHON[1];
}

/**
 * Which PyTorch build to install.
 *
 * The CUDA wheels are several times larger and useless without an NVIDIA
 * card, so the probe result decides rather than a blanket default.
 */
export function torchRequirementsFile(hasCuda: boolean): string {
  return hasCuda ? 'torch-cuda.txt' : 'torch-cpu.txt';
}

export class RuntimeManager extends EventEmitter {
  private readonly runner: ProcessRunner;
  private status: RuntimeStatus = {
    stage: 'idle',
    message: 'Not checked yet',
    fraction: 0,
    pythonPath: null,
    error: null,
    sidecarReady: false,
    capabilities: null,
  };
  private installing: Promise<RuntimeStatus> | null = null;

  constructor(private readonly options: RuntimeManagerOptions) {
    super();
    this.runner = options.runner ?? new NodeProcessRunner();
  }

  getStatus(): RuntimeStatus {
    return { ...this.status };
  }

  patchStatus(patch: Partial<RuntimeStatus>): RuntimeStatus {
    this.status = { ...this.status, ...patch };
    this.emit('changed', this.getStatus());
    return this.getStatus();
  }

  private setStage(
    stage: RuntimeStatus['stage'],
    message: string,
    fraction: number,
  ): void {
    this.patchStatus({ stage, message, fraction: Math.min(1, Math.max(0, fraction)) });
  }

  private fail(error: SipraErrorPayload): RuntimeStatus {
    return this.patchStatus({
      stage: 'failed',
      message: error.message,
      error,
      fraction: 0,
    });
  }

  /** Whether a usable environment already exists. */
  async detect(): Promise<RuntimeStatus> {
    this.setStage('checking', 'Looking for the audio runtime…', 0.05);
    const pythonPath = venvPythonPath(this.options.runtimeDir);

    if (!(await this.runner.exists(pythonPath))) {
      return this.patchStatus({
        stage: 'idle',
        message: 'Sipra needs to set up its audio runtime.',
        pythonPath: null,
        fraction: 0,
      });
    }

    const verified = await this.verify(pythonPath);
    if (!verified.ok) {
      return this.patchStatus({
        stage: 'idle',
        message: 'The audio runtime is incomplete and needs to be set up again.',
        pythonPath: null,
        fraction: 0,
      });
    }

    return this.patchStatus({
      stage: 'ready',
      message: 'Audio runtime ready.',
      pythonPath,
      fraction: 1,
      error: null,
    });
  }

  /** Create the environment. Safe to call repeatedly; installs run once. */
  async install(): Promise<RuntimeStatus> {
    if (this.installing) return this.installing;
    this.installing = this.runInstall().finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async runInstall(): Promise<RuntimeStatus> {
    try {
      const pythonPath = venvPythonPath(this.options.runtimeDir);

      if (!(await this.runner.exists(pythonPath))) {
        this.setStage('creating-environment', 'Creating a private Python environment…', 0.1);
        const created = await this.createEnvironment();
        if (!created.ok) {
          return this.fail({
            code: 'RUNTIME_ENV_FAILED',
            message: created.message,
            details: created.details,
          });
        }
      }

      this.setStage('installing-packages', 'Checking for a compatible GPU…', 0.25);
      const hasCuda = this.options.forceCpu ? false : await this.detectCuda();

      this.setStage(
        'installing-packages',
        hasCuda
          ? 'Installing the audio engine with GPU support. This is a one-time download of about 2.5 GB.'
          : 'Installing the audio engine. This is a one-time download of about 900 MB.',
        0.3,
      );

      const installed = await this.installPackages(pythonPath, hasCuda);
      if (!installed.ok) {
        return this.fail({
          code: 'RUNTIME_INSTALL_FAILED',
          message: installed.message,
          details: installed.details,
        });
      }

      this.setStage('verifying', 'Checking the installation…', 0.95);
      const verified = await this.verify(pythonPath);
      if (!verified.ok) {
        return this.fail({
          code: 'RUNTIME_VERIFY_FAILED',
          message: verified.message,
          details: verified.details,
        });
      }

      return this.patchStatus({
        stage: 'ready',
        message: 'Audio runtime ready.',
        pythonPath,
        fraction: 1,
        error: null,
      });
    } catch (error) {
      return this.fail({
        code: 'RUNTIME_UNEXPECTED',
        message: `Setup failed: ${(error as Error).message}`,
      });
    }
  }

  // -- environment creation -------------------------------------------

  private async createEnvironment(): Promise<{
    ok: boolean;
    message: string;
    details?: Record<string, unknown>;
  }> {
    await fs.mkdir(this.options.runtimeDir, { recursive: true });
    const venvDir = path.join(this.options.runtimeDir, 'venv');

    const uv = await this.locateUv();
    if (uv) {
      const result = await this.runner.run(
        uv,
        ['venv', '--python', PYTHON_VERSION, venvDir],
        { timeoutMs: 15 * 60_000, onOutput: (chunk) => this.emit('log', chunk) },
      );
      if (result.code === 0) return { ok: true, message: 'Created with uv' };
      this.emit('log', `uv venv failed: ${result.stderr}`);
    }

    const systemPython = await this.locateSystemPython();
    if (!systemPython) {
      return {
        ok: false,
        message:
          'Sipra could not find a way to set up Python. Install Python 3.11 from python.org, ' +
          'then click Retry.',
        details: { triedUv: Boolean(uv) },
      };
    }

    const result = await this.runner.run(systemPython, ['-m', 'venv', venvDir], {
      timeoutMs: 10 * 60_000,
      onOutput: (chunk) => this.emit('log', chunk),
    });
    if (result.code !== 0) {
      return {
        ok: false,
        message: 'Could not create the Python environment.',
        details: { stderr: result.stderr.slice(-1200) },
      };
    }
    return { ok: true, message: 'Created with system Python' };
  }

  private async locateUv(): Promise<string | null> {
    const bundled = path.join(this.options.binDir, uvBinaryName());
    if (await this.runner.exists(bundled)) return bundled;

    const cached = path.join(this.options.runtimeDir, 'tools', uvBinaryName());
    if (await this.runner.exists(cached)) return cached;

    return this.runner.which('uv');
  }

  private async locateSystemPython(): Promise<string | null> {
    const candidates =
      process.platform === 'win32'
        ? ['py', 'python', 'python3']
        : ['python3.12', 'python3.11', 'python3', 'python'];

    for (const candidate of candidates) {
      const resolved = candidate === 'py' ? 'py' : await this.runner.which(candidate);
      if (!resolved) continue;
      const args = candidate === 'py' ? ['-3', '--version'] : ['--version'];
      try {
        const result = await this.runner.run(resolved, args, { timeoutMs: 10_000 });
        if (result.code !== 0) continue;
        const version = parsePythonVersion(`${result.stdout}${result.stderr}`);
        if (meetsMinimumPython(version)) {
          return resolved;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Is there an NVIDIA GPU worth installing CUDA wheels for?
   *
   * `nvidia-smi` being present and exiting cleanly is the cheapest
   * reliable signal. A false negative costs performance; a false positive
   * costs a 2.5 GB download that then fails at runtime, so this errs
   * towards the CPU build.
   */
  async detectCuda(): Promise<boolean> {
    try {
      const result = await this.runner.run('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {
        timeoutMs: 15_000,
      });
      return result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async installPackages(
    pythonPath: string,
    hasCuda: boolean,
  ): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    const baseRequirements = path.join(this.options.requirementsDir, 'base.txt');
    const torchRequirements = path.join(
      this.options.requirementsDir,
      torchRequirementsFile(hasCuda),
    );

    const uv = await this.locateUv();
    let progress = 0.3;
    const bump = (message: string): void => {
      progress = Math.min(0.9, progress + 0.02);
      this.setStage('installing-packages', message, progress);
    };

    for (const [label, requirements] of [
      ['audio engine', torchRequirements],
      ['analysis tools', baseRequirements],
    ] as const) {
      bump(`Installing the ${label}…`);
      const args = uv
        ? ['pip', 'install', '--python', pythonPath, '-r', requirements]
        : ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements];
      const command = uv ?? pythonPath;

      const result = await this.runner.run(command, args, {
        timeoutMs: 60 * 60_000,
        onOutput: (chunk) => {
          this.emit('log', chunk);
          if (/Downloading|Installing|Resolved|Collecting/i.test(chunk)) {
            bump(`Installing the ${label}…`);
          }
        },
      });
      if (result.code !== 0) {
        return {
          ok: false,
          message:
            'Sipra could not download its audio engine. Check your internet connection and ' +
            'click Retry.',
          details: { requirements, stderr: result.stderr.slice(-1500) },
        };
      }
    }

    return { ok: true, message: 'Packages installed' };
  }

  /** Confirm the environment can actually import and run the core. */
  async verify(
    pythonPath: string,
  ): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> {
    try {
      const result = await this.runner.run(pythonPath, ['-m', 'sipra_core', '--version'], {
        cwd: this.options.corePath,
        timeoutMs: 120_000,
        env: { PYTHONDONTWRITEBYTECODE: '1' },
      });
      if (result.code !== 0) {
        return {
          ok: false,
          message: 'The audio runtime is installed but did not start correctly.',
          details: { stderr: result.stderr.slice(-1200) },
        };
      }
      return { ok: true, message: result.stdout.trim() };
    } catch (error) {
      return {
        ok: false,
        message: `Could not run the audio runtime: ${(error as Error).message}`,
      };
    }
  }
}
