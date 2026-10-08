import Link from "next/link";

export function AdminNav({ current }: { current: "dashboard" | "users" | "layers" | "upload" }) {
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
      <Link href="/admin/layers" aria-current={current === "layers" ? "page" : undefined}>Layers</Link>
      <Link href="/admin/upload" aria-current={current === "upload" ? "page" : undefined}>Upload Data</Link>
    </nav>
  );
}
