"use client";

import { useFormStatus } from "react-dom";

export function ApproveUserButton({ email }: { email: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      className="button button-primary approval-submit"
      disabled={pending}
      aria-label={pending ? `Approving ${email}` : `Approve ${email} as Viewer`}
      aria-busy={pending}
    >
      {pending ? "Approving…" : "Approve"}
    </button>
  );
}
