import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeJsonAtomic } from "../util/atomic-json.ts";
import { IdentityContext } from "./context.ts";

/**
 * The workspaces where a person has turned one of their own skills off
 * (ADR-0072), at `users/<userId>/skills-off.json`.
 *
 * A person's own (`user`-tier) skill applies in every workspace they are in
 * (ADR-0069) unless they turn it off in one. The off list belongs to the
 * person, so it is stored on their record and never in a workspace's
 * partition: no other member can read it, and removing it from one workspace
 * changes nothing in another.
 *
 * Entries key on the skill's manifest name, the same key the tiers merge on
 * (ADR-0019) and conversation mutes use (ADR-0034). Removing a name from the
 * user tier lets a same-named workspace or org skill win that workspace.
 *
 * Reads are synchronous because the per-run skill overlay
 * (`Runtime.loadConversationSkills`) is. Writes are read-modify-write with an
 * atomic commit, and each runs whole inside a per-person chain: the record is
 * replaced wholesale, so two overlapping writes would each persist their own
 * read and the later would erase the earlier, even for different workspaces.
 */

const RECORD_VERSION = 1 as const;
const RECORD_FILENAME = "skills-off.json";

/** On-disk shape. `workspaces` maps a workspace id to the skill names off there. */
interface SkillsOffRecord {
  version: typeof RECORD_VERSION;
  workspaces: Record<string, string[]>;
}

function recordPath(workDir: string, userId: string): string {
  return new IdentityContext({ userId, workDir }).getDataPath("root", RECORD_FILENAME);
}

function readRecord(workDir: string, userId: string): Record<string, string[]> {
  let content: string;
  try {
    content = readFileSync(recordPath(workDir, userId), "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const record = JSON.parse(content) as Partial<SkillsOffRecord>;
  const workspaces = record.workspaces;
  if (!workspaces || typeof workspaces !== "object") return {};
  const out: Record<string, string[]> = {};
  for (const [wsId, names] of Object.entries(workspaces)) {
    if (Array.isArray(names)) out[wsId] = names.filter((n) => typeof n === "string");
  }
  return out;
}

async function writeRecord(
  workDir: string,
  userId: string,
  workspaces: Record<string, string[]>,
): Promise<void> {
  const path = recordPath(workDir, userId);
  mkdirSync(dirname(path), { recursive: true });
  const record: SkillsOffRecord = { version: RECORD_VERSION, workspaces };
  await writeJsonAtomic(path, record);
}

/**
 * One read-through-write at a time per person, the same chain as
 * `serializePerWorkspace` keyed on the person instead. In-process only, which
 * holds while a tenant runs one runtime pod.
 */
const writeChains = new Map<string, Promise<unknown>>();

function serializePerUser<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const next = (writeChains.get(userId) ?? Promise.resolve()).then(task, task);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  writeChains.set(userId, tail);
  void tail.then(() => {
    if (writeChains.get(userId) === tail) writeChains.delete(userId);
  });
  return next;
}

/** The names of the person's own skills they turned off in `wsId`. Empty when none. */
export function skillsOffIn(workDir: string, userId: string, wsId: string): Set<string> {
  return new Set(readRecord(workDir, userId)[wsId] ?? []);
}

/**
 * Turn one of the person's own skills on or off in one workspace. Idempotent:
 * turning on a skill that is not off, or off one that already is, writes
 * nothing.
 */
export async function setSkillOnIn(
  workDir: string,
  userId: string,
  wsId: string,
  name: string,
  on: boolean,
): Promise<void> {
  return serializePerUser(userId, async () => {
    const workspaces = readRecord(workDir, userId);
    const current = workspaces[wsId] ?? [];
    const has = current.includes(name);
    if (on !== has) return;
    if (on) {
      const next = current.filter((n) => n !== name);
      if (next.length > 0) workspaces[wsId] = next;
      else delete workspaces[wsId];
    } else {
      workspaces[wsId] = [...current, name].sort();
    }
    await writeRecord(workDir, userId, workspaces);
  });
}

/**
 * Forget a skill in every workspace, so a later skill of the same name starts
 * on everywhere. Called when the person deletes the skill.
 */
export async function clearSkillOffs(workDir: string, userId: string, name: string): Promise<void> {
  return serializePerUser(userId, async () => {
    const workspaces = readRecord(workDir, userId);
    let changed = false;
    for (const [wsId, names] of Object.entries(workspaces)) {
      if (!names.includes(name)) continue;
      changed = true;
      const next = names.filter((n) => n !== name);
      if (next.length > 0) workspaces[wsId] = next;
      else delete workspaces[wsId];
    }
    if (changed) await writeRecord(workDir, userId, workspaces);
  });
}
