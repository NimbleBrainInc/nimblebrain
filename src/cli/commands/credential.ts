import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { FileCredentialStore } from "../../tools/credential-store.ts";
import { WorkspaceContext } from "../../workspace/context.ts";
import { log } from "../../observability/log.ts";

/**
 * `nb credential ...` — manage workspace-scoped opaque secrets used by
 * pre-registered OAuth clients (Track A) and other future credential
 * consumers. Backed by `FileCredentialStore` (mode 0o600 files under
 * `<workDir>/workspaces/<wsId>/credentials/secrets/`).
 *
 * Subcommands:
 *
 *   nb credential set <wsId> <key> <value>
 *     Write a secret. Existing values are replaced atomically.
 *
 *   nb credential get <wsId> <key>
 *     Print the secret to stdout. Designed for piping into another
 *     command — no log decoration. Exits non-zero when missing.
 *
 *   nb credential delete <wsId> <key>
 *     Remove a secret. Idempotent (succeeds silently when absent).
 *
 *   nb credential list <wsId>
 *     List the secret keys for a workspace. Values are NOT printed.
 *
 * `--work-dir` overrides the default work dir (`~/.nimblebrain` or
 * `$NB_WORK_DIR`). Useful when running against a non-default
 * deployment from a one-off shell.
 *
 * Note: this is the first-line operator UX for seeding `oauthClient.
 * clientSecret` references in `workspace.json`. Track C's web UI
 * exposes the same operation behind an admin-only modal.
 */
export function createCredentialCommand(): Command {
  const cmd = new Command("credential")
    .alias("creds")
    .description("Manage workspace-scoped opaque secrets (OAuth client_secret, API keys)");

  cmd
    .command("set <wsId> <key> <value>")
    .description("Set or replace a secret value")
    .option("--work-dir <path>", "override the default work directory")
    .action(async (wsId: string, key: string, value: string, opts: { workDir?: string }) => {
      const store = new FileCredentialStore(resolveWorkDir(opts.workDir));
      await store.put(wsId, key, value);
      log.info(`[credential] set ${wsId}:${key} (${value.length} chars)`);
    });

  cmd
    .command("get <wsId> <key>")
    .description("Print a secret value to stdout (designed for piping)")
    .option("--work-dir <path>", "override the default work directory")
    .action(async (wsId: string, key: string, opts: { workDir?: string }) => {
      const store = new FileCredentialStore(resolveWorkDir(opts.workDir));
      const value = await store.get(wsId, key);
      if (!value) {
        process.stderr.write(`[credential] not found: ${wsId}:${key}\n`);
        process.exit(1);
      }
      // Plain stdout — no trailing newline so `nb credential get | curl
      // -H "Authorization: Bearer $(...)"`-style piping is clean.
      process.stdout.write(value.reveal());
    });

  cmd
    .command("delete <wsId> <key>")
    .alias("rm")
    .description("Remove a secret (idempotent)")
    .option("--work-dir <path>", "override the default work directory")
    .action(async (wsId: string, key: string, opts: { workDir?: string }) => {
      const store = new FileCredentialStore(resolveWorkDir(opts.workDir));
      await store.delete(wsId, key);
      log.info(`[credential] deleted ${wsId}:${key}`);
    });

  cmd
    .command("list <wsId>")
    .alias("ls")
    .description("List secret keys for a workspace (values are not printed)")
    .option("--work-dir <path>", "override the default work directory")
    .action(async (wsId: string, opts: { workDir?: string }) => {
      const workDir = resolveWorkDir(opts.workDir);
      // Direct fs read here rather than extending CredentialStore — list
      // is operator-only diagnostic UX, not part of the runtime contract
      // the SaaS-encrypted store will need to support. The path still
      // goes through WorkspaceContext so the layout has one definition
      // site (`src/workspace/context.ts`).
      const { existsSync, readdirSync } = await import("node:fs");
      const dir = new WorkspaceContext({ wsId, workDir }).getDataPath("credentials", "secrets");
      if (!existsSync(dir)) {
        log.info(`[credential] no secrets in ${wsId}`);
        return;
      }
      const keys = readdirSync(dir).sort();
      if (keys.length === 0) {
        log.info(`[credential] no secrets in ${wsId}`);
        return;
      }
      for (const k of keys) process.stdout.write(`${k}\n`);
    });

  return cmd;
}

function resolveWorkDir(override: string | undefined): string {
  if (override) return override;
  return process.env.NB_WORK_DIR ?? join(homedir(), ".nimblebrain");
}
