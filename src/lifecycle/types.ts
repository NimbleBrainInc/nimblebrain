/**
 * Connector lifecycle events — the two moments the runtime can tell a bundle
 * something about its own installation.
 *
 * The notification is a **tool call on the bundle itself**, and that one fact
 * decides the whole vocabulary. Before a connector is reachable there is no
 * server to call; after its source is torn down there is nothing left to call.
 * So the callable set is exactly the two transitions in between: the first
 * moment the bundle is reachable, and the last moment before it goes away.
 *
 * The rule that falls out, and the reason this block will not grow:
 *
 * > Before a connector is reachable and after it is gone, extension is
 * > DECLARATIVE — the manifest tells the runtime what to do. In between,
 * > extension is CALLABLE — the runtime calls the bundle.
 *
 * The "missing" events are therefore not gaps and some already ship:
 * install-time secret collection is the pre-install extension point, declared
 * as *what I need* rather than as a call, and the hook revoke plus the
 * owned-secret delete are the post-uninstall ones, performed by the runtime off
 * the connector's own record. Kubernetes (`postStart`/`preStop`), VS Code
 * (`activate`/`deactivate`) and Chrome (`onInstalled`/`onSuspend`) converge on
 * the same two for the same reason; Helm and npm carry the full matrix because
 * their hooks run in a context the manager controls and never call into the
 * thing being managed.
 *
 * **Nothing here describes what a bundle should DO with either event**, and
 * nothing ever should — the same line `HostManifestMeta.hooks` holds. The
 * kernel says *you were installed*; what that means is the bundle's business. A
 * `provisioning:` block naming what to provision would put a vendor-shaped
 * taxonomy in the kernel, which is precisely the thing this shape avoids.
 */

/**
 * The events a manifest may name a handler for.
 *
 * Keyed by **event**, not by field: a later event is a new key rather than a
 * new field, and the runtime's parse is one loop over this list. Naming a key
 * after the mechanism (`installed_tool` and friends) would say only that
 * connectors expose tools, which is already true of everything.
 */
export const LIFECYCLE_EVENTS = ["on_ready", "on_removing"] as const;

export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/**
 * The `lifecycle` block, as a server declares it. Both entries optional; a
 * server may declare either alone.
 *
 * ```json
 * "lifecycle": { "on_ready": "workspace_ready", "on_removing": "workspace_removing" }
 * ```
 *
 * The value is the tool that handles the event, named in the server's own bare
 * vocabulary.
 */
export type LifecycleDeclaration = Partial<Record<LifecycleEvent, string>>;

/**
 * Why `on_ready` is firing.
 *
 * One event with a discriminator rather than two events, because there is one
 * delivery contract to honour — *at least once per connector per runtime boot
 * in which its source comes up* — and splitting it would advertise two, one of
 * which (*exactly once per install*) the runtime cannot keep: a source that
 * never comes up is never called at all, and one that comes up again on a later
 * boot is called again.
 *
 * **`resume` is one value for every non-install reason** — a cold boot, a
 * reconnect, a re-auth, a server redeployed under the same URL. They are one
 * value because a bundle has nothing to do differently with them and the
 * runtime frequently cannot tell them apart. The discriminator answers exactly
 * one question — *was this the install?* — and `resume` is the honest name for
 * "no".
 */
export type LifecycleReadyReason = "install" | "resume";
