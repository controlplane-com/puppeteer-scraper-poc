// ANCHOR - Imports

// Node built-ins
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// ANCHOR - Types

/**
 * @typedef {Object} RunCronWorkloadInput
 * @property {string} org - Control Plane organization name.
 * @property {string} gvc - GVC the cron workload will be provisioned in.
 * @property {string} image - Image reference (e.g. `//image/scraper:latest`).
 * @property {string} [cpu] - CPU allocation for the runner (e.g. `500m`).
 * @property {string} [memory] - Memory allocation for the runner (e.g. `1Gi`).
 * @property {Record<string, string>} [env] - Env vars to pass to the runner.
 * @property {string[]} [command] - Command to execute inside the container.
 * @property {string} [identity] - Identity to attach to the runner workload.
 * @property {import('pino').Logger} [logger] - Logger for diagnostic output.
 * @property {number} [timeoutMs] - Max time to wait for the CLI call.
 */

/**
 * @typedef {Object} RunCronWorkloadResult
 * @property {string} stdout - CLI stdout (trimmed).
 * @property {string} stderr - CLI stderr (trimmed).
 */

// ANCHOR - Constants

/** Path to the `cpln` binary. Overridable for local tests. */
const CPLN_BIN = process.env.CPLN_BIN ?? "cpln";

/** How long we'll wait for the CLI before giving up. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Control Plane API endpoint used by the CLI. Inside a workload the mesh
 * expects plain HTTP (the Envoy sidecar handles TLS on the wire). Overridable
 * via CPLN_API_ENDPOINT so the same code works on a developer machine.
 */
const API_ENDPOINT = process.env.CPLN_API_ENDPOINT ?? "http://api.cpln.io";

// ANCHOR - Helpers

// Promisified execFile for async/await usage.
const execFileAsync = promisify(execFile);

// ANCHOR - Public Functions

/**
 * Triggers an on-demand cron run via the `cpln workload cron run` CLI.
 *
 * The CLI provisions the cron workload from the given image/env/command and
 * reuses it across subsequent calls, so we don't declare a cron workload in
 * any manifest. Auth comes from CPLN_TOKEN — Control Plane auto-injects it
 * into every workload and scopes it to the workload's identity.
 *
 * @param {RunCronWorkloadInput} input - Run configuration.
 * @returns {Promise<RunCronWorkloadResult>} CLI stdout / stderr.
 */
export async function runCronWorkload(input) {
  const { org, gvc, image, logger, timeoutMs = DEFAULT_TIMEOUT_MS } = input;

  // Validate required inputs — fail fast rather than letting the CLI emit an opaque error.
  if (!org || !gvc || !image) {
    throw new Error("runCronWorkload: org, gvc, and image are required");
  }

  // Build argv for execFile. Using an array (not a shell string) keeps user
  // input from being interpreted by /bin/sh — URLs with `;`, `$()`, etc.
  // travel through argv safely.
  const args = buildArgs(input);

  logger?.info(
    { image, envKeys: Object.keys(input.env ?? {}) },
    "invoking cpln workload cron run",
  );

  try {
    // Spawn the cpln process and wait for completion.
    const result = await execFileAsync(CPLN_BIN, args, {
      timeout: timeoutMs,
      env: process.env,
      maxBuffer: 1_000_000,
    });

    return {
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    // Wrap with richer context so HTTP handlers can log useful diagnostics.
    const wrapped = new Error(
      `cpln workload cron run failed (code=${error.code ?? "n/a"})`,
    );
    wrapped.cause = error;
    wrapped.stderr = error.stderr?.toString().trim();
    wrapped.stdout = error.stdout?.toString().trim();
    throw wrapped;
  }
}

// ANCHOR - Private Functions

/**
 * Builds the argv array for `cpln workload cron run`.
 *
 * @param {RunCronWorkloadInput} input - Run configuration.
 * @returns {string[]} The argv to pass to execFile.
 */
function buildArgs(input) {
  const { org, gvc, image, cpu, memory, env, command, identity } = input;

  // Core flags — always present.
  const args = [
    "workload",
    "cron",
    "run",
    "--org",
    org,
    "--gvc",
    gvc,
    "--endpoint",
    API_ENDPOINT,
    "--image",
    image,
    "--background",
  ];

  // Optional resource sizing.
  if (cpu) {
    args.push("--cpu", cpu);
  }

  if (memory) {
    args.push("--memory", memory);
  }

  // Optional identity binding for the runner workload.
  if (identity) {
    args.push("--identity", identity);
  }

  // Environment variables to hand off to the runner.
  for (const [key, value] of Object.entries(env ?? {})) {
    args.push("--env", `${key}=${value}`);
  }

  // Command (if provided) must appear after the `--` separator.
  if (Array.isArray(command) && command.length > 0) {
    args.push("--", ...command);
  }

  return args;
}
