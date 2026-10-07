import Link from "next/link";

export function AdminNav({ current }: { current: "dashboard" | "users" }) {
  return (
    <nav className="admin-nav" aria-label="Administration sections">
      <Link
        href="/admin"
        aria-current={current === "dashboard" ? "page" : undefined}
      >
        Dashboard
      </Link>
      <Link
        href="/admin/users"
        aria-current={current === "users" ? "page" : undefined}
      >
        Users
      </Link>
      <span aria-disabled="true" title="Not available yet">
        Layers <small>Coming later</small>
      </span>
      <span aria-disabled="true" title="Not available yet">
        Upload Data <small>Coming later</small>
      </span>
    </nav>
  );
}
