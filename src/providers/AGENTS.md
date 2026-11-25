# Providers

Scope: `src/providers/`, the infrastructure the kernel uses and no agent calls (ADR-0076, "Providers carry the infrastructure"), such as the work queue (`queue/`).

- **The work queue's first consumer is the tasks scheduler** (`src/platform/tasks/scheduler.ts`, guide `src/platform/tasks/AGENTS.md`, "The work queue"): scheduled and requested task runs. The runtime opens the queue at boot (`src/runtime/work-queue.ts`, `<workDir>/queue`), hands it out as `Runtime.getWorkQueue()`, and closes it at shutdown after the sources that use it have stopped. A deployment that names another implementation chooses it in `openWorkQueue`.

- **A provider is a kernel interface, not a plugin.** It has no tools and no screen and is never reached over MCP. Its contract is the TypeScript interface in `<provider>/types.ts`, and the doc comments there are normative: every rule a caller may rely on is written there, and nowhere else.
- **Every interface has a conformance suite** in `test/helpers/<name>-conformance.ts` (`work-queue-conformance.ts`), parameterised by a factory, with one test per rule in the doc comments. A rule added to the interface lands with its test. A property not every implementation has (durability, several instances on one store) is a capability the implementation declares; the cases for one it lacks are skipped by name, never passed silently. An implementation is valid when it passes the suite; its own tests cover only what the interface does not (files, locks).
- **The local filesystem implementation ships; nothing else does here.** It runs with no other service present, so `npx nimblebrain` works out of the box. Implementations for scale (a database, a managed queue) live outside this repository and pass the same suite. No in-memory implementation: tests run the filesystem one in a temp directory.
- **Every provider declares `multiProcess`**: whether more than one runtime process may use its store at once. A filesystem implementation serves one process and says false.
- **A method has a named consumer.** Add one only when a kernel caller needs it now; a capability someone might want is not a reason.
- **A provider takes its location from the caller.** The runtime passes the directory (an instance-level path under `<workDir>`, never under `workspaces/`); a provider never chooses one.
