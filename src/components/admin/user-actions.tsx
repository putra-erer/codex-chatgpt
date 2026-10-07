"use client";

import { useFormStatus } from "react-dom";
import { changeUser } from "@/app/admin/users/actions";
import type { UserFilters } from "@/lib/users/management";

function Submit({
  children,
  danger = false,
}: {
  children: string;
  danger?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`button ${danger ? "button-danger" : "button-quiet"}`}
    >
      {pending ? "Saving…" : children}
    </button>
  );
}
export function UserActions({
  account,
  filters,
  self,
}: {
  account: {
    id: string;
    email: string;
    status: string;
    role: "VIEWER" | "ADMIN";
    version: string;
    bootstrap: boolean;
    linked: boolean;
  };
  filters: UserFilters;
  self: boolean;
}) {
  if (account.bootstrap)
    return <span className="muted">Protected administrator</span>;
  if (!account.linked)
    return <span className="muted">Verified Google sign-in required</span>;
  function fields(action: string) {
    return (
      <>
        <input type="hidden" name="userId" value={account.id} />
        <input type="hidden" name="version" value={account.version} />
        <input type="hidden" name="action" value={action} />
        <input type="hidden" name="filterStatus" value={filters.status} />
        <input type="hidden" name="filterRole" value={filters.role} />
        <input type="hidden" name="q" value={filters.q} />
        <input type="hidden" name="page" value={filters.page} />
      </>
    );
  }
  return (
    <div className="user-actions">
      {account.status !== "APPROVED" && (
        <form
          action={changeUser}
          data-user-id={account.id}
          data-operation="approve"
          onSubmit={(event) => {
            if (
              account.role === "ADMIN" &&
              !window.confirm(
                `Approve ${account.email} with administrator access?`,
              )
            )
              event.preventDefault();
          }}
        >
          {fields("approve")}
          <Submit>Approve</Submit>
        </form>
      )}
      {account.status !== "REJECTED" && (
        <form
          action={changeUser}
          data-user-id={account.id}
          data-operation="reject"
          onSubmit={(event) => {
            if (
              !window.confirm(
                `Reject ${account.email}? All current sessions will be signed out.${self ? " This is your own account." : ""}`,
              )
            )
              event.preventDefault();
          }}
        >
          {fields("reject")}
          <Submit danger>Reject</Submit>
        </form>
      )}
      <form
        action={changeUser}
        data-user-id={account.id}
        data-operation="role"
        onSubmit={(event) => {
          const role = new FormData(event.currentTarget).get("role");
          if (
            !window.confirm(
              `Change ${account.email} to ${role}? Permissions will change immediately.${self ? " This is your own account." : ""}`,
            )
          )
            event.preventDefault();
        }}
      >
        {fields("role")}
        <select
          name="role"
          defaultValue={account.role}
          aria-label={`Role for ${account.email}`}
        >
          <option value="VIEWER">Viewer</option>
          <option value="ADMIN">Admin</option>
        </select>
        <Submit>Save role</Submit>
      </form>
    </div>
  );
}
