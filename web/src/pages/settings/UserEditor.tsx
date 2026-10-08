import { type ChangeEvent, useCallback } from "react";
import { callToolWithoutWorkspace } from "../../api/client";
import { Input } from "../../components/ui/input";
import { Select } from "../../components/ui/select";
import { useAutosaveForm } from "../../hooks/useAutosaveForm";
import { AutosaveField } from "./components";
import {
  ORG_ROLE_OPTIONS,
  type OrgRole,
  removesAdminRights,
  type UserEditField,
  type UserEditValues,
  userEditPatch,
} from "./user-edit-patch";

export interface EditableUser {
  id: string;
  email: string;
  displayName: string;
  orgRole: OrgRole;
}

const ALL_UNDO: Record<UserEditField, { undo: true }> = {
  displayName: { undo: true },
  email: { undo: true },
  orgRole: { undo: true },
};

/**
 * One user's display name, email and org role, each saving as it changes
 * (`useAutosaveForm`) through `manage_users`' `update` action.
 *
 * What a control disables mirrors what the server refuses (`user-tools.ts`):
 * your own role and any field the identity provider owns. (The server also
 * keeps the last active admin; only an admin reaches this page, so that admin
 * is always the viewer, whose role is already locked.) The server re-checks every save, and its refusal shows on the
 * field. A change that takes away admin rights asks first, as deactivation does.
 */
export function UserEditor({
  user,
  isSelf,
  providerOwnedFields,
  onSaved,
}: {
  user: EditableUser;
  isSelf: boolean;
  providerOwnedFields: readonly string[];
  /** Called after any field saves, so the list can re-read. */
  onSaved: () => void;
}) {
  const save = useCallback(
    async <K extends UserEditField>(field: K, value: UserEditValues[K]) => {
      const res = await callToolWithoutWorkspace(
        "nb",
        "manage_users",
        userEditPatch(user.id, field, value),
      );
      // A refusal comes back as a result, not a throw; without this it would
      // be reported as saved.
      if (res.isError) throw new Error(res.content?.[0]?.text ?? "The change was not saved.");
    },
    [user.id],
  );

  const form = useAutosaveForm<UserEditValues>(
    { displayName: user.displayName, email: user.email, orgRole: user.orgRole },
    {
      save,
      onSaved,
      labels: {
        displayName: `${user.displayName}'s display name`,
        email: `${user.displayName}'s email`,
        orgRole: `${user.displayName}'s role`,
      },
      notices: ALL_UNDO,
    },
  );

  const emailOwned = providerOwnedFields.includes("email");
  const roleHint = isSelf ? "You can't change your own role. Ask another admin." : undefined;

  const onRoleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as OrgRole;
    if (
      removesAdminRights(form.values.orgRole, next) &&
      !window.confirm(
        `Make ${user.displayName} a member? They will no longer be able to manage users, workspaces, or organization settings.`,
      )
    ) {
      return;
    }
    form.commit("orgRole", next);
  };

  const fieldId = (field: UserEditField) => `user-${user.id}-${field}`;

  return (
    <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-3">
      <AutosaveField
        id={fieldId("displayName")}
        label="Display name"
        {...form.fieldState("displayName")}
      >
        <Input id={fieldId("displayName")} {...form.inputProps("displayName")} />
      </AutosaveField>

      <AutosaveField
        id={fieldId("email")}
        label="Email"
        {...form.fieldState("email")}
        hint={
          emailOwned
            ? "Your identity provider signs people in by email, so it is changed there."
            : undefined
        }
      >
        <Input
          id={fieldId("email")}
          type="email"
          disabled={emailOwned}
          {...form.inputProps("email")}
        />
      </AutosaveField>

      <AutosaveField
        id={fieldId("orgRole")}
        label="Role"
        {...form.fieldState("orgRole")}
        hint={roleHint}
      >
        <Select
          id={fieldId("orgRole")}
          disabled={isSelf}
          {...form.selectProps("orgRole")}
          onChange={onRoleChange}
        >
          {ORG_ROLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </AutosaveField>
    </div>
  );
}
