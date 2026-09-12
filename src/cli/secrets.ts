import { parseArgs } from "node:util";
import type { SecretsConfig } from "../config/secrets.ts";
import { defaultWorkDir } from "../connectors/runtime/paths.ts";
import type { CredentialScope, CredentialStore } from "../tools/credential-store.ts";
import {
  createCredentialStore,
  registerBuiltinCredentialStoreBackends,
} from "../tools/credential-store-backend.ts";
import { loadConfig } from "./config.ts";

/**
 * `secrets` — the operator's door to the credential store.
 *
 * It exists because sealing closed the only one that was there. An instance
 * secret has no UI (a workspace secret has the connector's settings page; a
 * user secret is written by the OAuth flow that acquired it), so the documented
 * way to set one has always been to write the file by hand. Once the files hold
 * ciphertext there is nothing to hand-write, and once the boot sweep has run
 * the store refuses a plaintext file outright.
 *
 * It holds no format knowledge. It builds the store the way the composition
 * root does, from the same `secrets` config block, and calls the same four
 * methods — so it seals exactly when the deployment seals, and a later vault
 * backend needs no change here.
 *
 * ## This is NOT an agent tool, and must never become one
 *
 * The temptation is real: the runtime's whole shape is "the agent reaches
 * tools", and `secrets.list` / `secrets.get` would drop straight into that
 * surface. **Do not.** A tool the model can call is a tool a prompt injection
 * can call, and those two would turn any injection into credential
 * exfiltration — from every scope at once, including the instance keys that
 * belong to the deployment rather than to any tenant.
 *
 * Workspace-scoped writes already have their reviewed surface: `set_secret` on
 * `manage_connectors`, which is workspace-only and gated on workspace admin.
 * Nothing else grows one. If you are here because you want an agent to use a
 * secret, it already can — through the connector that holds it, at the moment
 * it makes the request, which is why the store hands back a `Redacted` that
 * audits on reveal instead of a string.
 */

const SCOPES = ["instance", "workspace", "user"] as const;
type ScopeName = (typeof SCOPES)[number];

const USAGE = `Usage:
  secrets set <key>     [--scope <scope>] [--workspace <id>] [--user <id>] [--config <path>]
  secrets list          [--scope <scope>] [--workspace <id>] [--user <id>] [--config <path>]
  secrets delete <key>  [--scope <scope>] [--workspace <id>] [--user <id>] [--config <path>]

  --scope      instance (default) | workspace | user
  --workspace  workspace id, required for --scope workspace
  --user       user id, required for --scope user
  --config     path to nimblebrain.json

\`set\` reads the value from stdin, or prompts for it when stdin is a terminal.
It is never taken from the command line, where it would land in shell history
and in the process list. No command prints a secret.
`;

/** Thrown for anything the operator can fix by retyping the command. */
class UsageError extends Error {}

function parseScope(values: {
  scope?: string | undefined;
  workspace?: string | undefined;
  user?: string | undefined;
}): CredentialScope {
  const name = (values.scope ?? "instance") as ScopeName;
  if (!SCOPES.includes(name)) {
    throw new UsageError(`unknown --scope "${name}" (expected ${SCOPES.join(", ")})`);
  }
  if (name === "workspace") {
    if (!values.workspace) throw new UsageError("--scope workspace requires --workspace <id>");
    return { kind: "workspace", wsId: values.workspace };
  }
  if (name === "user") {
    if (!values.user) throw new UsageError("--scope user requires --user <id>");
    return { kind: "user", userId: values.user };
  }
  // An id passed against the wrong scope is a command that would write
  // somewhere other than where the operator meant, silently.
  if (values.workspace || values.user) {
    throw new UsageError("--workspace and --user apply only to their own --scope");
  }
  return { kind: "instance" };
}

/**
 * Read the secret from stdin, trimming ONE trailing newline — `echo` and every
 * heredoc add one, and almost no secret ends in one. It is the same affordance
 * the plaintext file path has always had, applied where the operator can see it
 * rather than silently on read.
 */
export async function readValueFromStream(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks)
    .toString("utf-8")
    .replace(/\r?\n$/, "");
}

const KEY_ENTER = ["\r", "\n"];
const KEY_EOT = "\u0004";
const KEY_INTERRUPT = "\u0003";
const KEY_BACKSPACE = ["\u007f", "\b"];

/**
 * What one keystroke means at the hidden prompt.
 *
 * Split out and exported because raw-mode terminal input is otherwise the one
 * part of this command a test cannot reach — and getting `erase` wrong at a
 * prompt with no echo means the operator cannot see that their correction did
 * nothing.
 */
export function classifyPromptKey(ch: string): "submit" | "cancel" | "erase" | "append" {
  if (KEY_ENTER.includes(ch) || ch === KEY_EOT) return "submit";
  if (ch === KEY_INTERRUPT) return "cancel";
  if (KEY_BACKSPACE.includes(ch)) return "erase";
  return "append";
}

/**
 * Prompt on a terminal with the echo off, so the value never reaches the
 * scrollback of a shared screen or a recorded session.
 */
function promptForValue(label: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    let value = "";
    const finish = (err?: Error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (classifyPromptKey(ch)) {
          case "submit":
            return finish();
          case "cancel":
            return finish(new UsageError("cancelled"));
          case "erase":
            value = value.slice(0, -1);
            break;
          default:
            value += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Build the store the way `runServe` does, from the same config.
 *
 * **`defaultWorkDir()` is not optional here.** Without it, `resolveConfigPath`
 * skips the work directory's own `nimblebrain.json` and falls through to one in
 * the current directory — auto-creating an empty one if none exists — and
 * `absoluteWorkDir` returns nothing, so the store roots wherever the operator
 * happened to be standing. Both are silent: the write succeeds, into a
 * directory the server never reads, and a deployment configured to seal writes
 * plaintext because the config that asked for sealing was never opened.
 */
function openStore(configPath: string | undefined): CredentialStore {
  const config = loadConfig({
    ...(configPath ? { config: configPath } : {}),
    defaultWorkDir: defaultWorkDir(),
  });
  registerBuiltinCredentialStoreBackends();
  return createCredentialStore({
    // `loadConfig` always resolves one now that a default is passed; the
    // fallback keeps the type honest rather than guarding a reachable case.
    workDir: config.workDir ?? defaultWorkDir(),
    secrets: config.secrets as SecretsConfig | undefined,
  });
}

export interface SecretsCommandIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Where `set` gets the value. Injected so the command is reachable from a test. */
  readValue: (key: string) => Promise<string>;
}

const DEFAULT_IO: SecretsCommandIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  readValue: (key) =>
    process.stdin.isTTY
      ? promptForValue(`Value for ${key} (input hidden): `)
      : readValueFromStream(process.stdin),
};

/**
 * Run one `secrets` invocation. Returns the exit code rather than calling
 * `process.exit`, so the whole command is reachable from a test.
 */
export async function runSecrets(
  argv: string[],
  io: SecretsCommandIo = DEFAULT_IO,
  openStoreFn: (configPath: string | undefined) => CredentialStore = openStore,
): Promise<number> {
  let positionals: string[];
  let values: Record<string, string | undefined>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        scope: { type: "string" },
        workspace: { type: "string" },
        user: { type: "string" },
        config: { type: "string", short: "c" },
      },
      allowPositionals: true,
    });
    positionals = parsed.positionals;
    values = parsed.values;
  } catch (err) {
    io.stderr(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }

  const [action, key, ...rest] = positionals;
  if (rest.length > 0) {
    // The likeliest stray positional is the value itself, so say why it is
    // refused rather than only that it is.
    io.stderr(
      `unexpected argument "${rest[0]}" — a secret is never passed on the command line\n${USAGE}`,
    );
    return 2;
  }

  try {
    const scope = parseScope(values);
    const store = openStoreFn(values.config);
    switch (action) {
      case "set":
        return await setSecret(store, scope, key, io);
      case "list":
        return await listSecrets(store, scope, key, io);
      case "delete":
        return await deleteSecret(store, scope, key, io);
      default:
        io.stderr(action ? `unknown command "${action}"\n${USAGE}` : USAGE);
        return 2;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`${err.message}\n${USAGE}`);
      return 2;
    }
    io.stderr(`secrets: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function setSecret(
  store: CredentialStore,
  scope: CredentialScope,
  key: string | undefined,
  io: SecretsCommandIo,
): Promise<number> {
  if (!key) throw new UsageError("set requires a key");
  const value = await io.readValue(key);
  if (value.length === 0) {
    // An empty value is almost always a pipeline that produced nothing, and it
    // would replace a working credential with a blank that fails at a vendor.
    throw new UsageError(`refusing to set "${key}" to an empty value`);
  }
  await store.put(scope, key, value);
  io.stderr(`set ${key}`); // the key, never the value
  return 0;
}

async function listSecrets(
  store: CredentialStore,
  scope: CredentialScope,
  key: string | undefined,
  io: SecretsCommandIo,
): Promise<number> {
  if (key) throw new UsageError("list takes no key");
  const entries = await store.list(scope);
  if (entries.length === 0) {
    io.stderr("no secrets set in this scope");
    return 0;
  }
  // Presence and age, which is all `list` has ever returned. There is no
  // command that prints a value: using one is the connector's job, at the
  // moment it needs it, through the path that audits the reveal.
  for (const entry of entries) {
    io.stdout(`${entry.key}\t${entry.updatedAt}`);
  }
  return 0;
}

async function deleteSecret(
  store: CredentialStore,
  scope: CredentialScope,
  key: string | undefined,
  io: SecretsCommandIo,
): Promise<number> {
  if (!key) throw new UsageError("delete requires a key");
  await store.delete(scope, key);
  io.stderr(`deleted ${key}`);
  return 0;
}
