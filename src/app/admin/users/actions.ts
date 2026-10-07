"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/server/authorization/guards";
import { getDb } from "@/server/db";
import { manageUser, UserManagementError } from "@/server/users/management";
import { changeSchema, userFilters, usersUrl } from "@/lib/users/management";

export async function changeUser(form: FormData) {
  const actor = await requireAdmin();
  const filters = userFilters({
    status: form.get("filterStatus"),
    role: form.get("filterRole"),
    q: form.get("q"),
    page: form.get("page"),
  });
  const parsed = changeSchema.safeParse(
    Object.fromEntries(
      ["userId", "version", "action", "role"].map((key) => [
        key,
        form.get(key),
      ]),
    ),
  );
  if (
    !parsed.success ||
    ["userId", "version", "action", "role"].some(
      (key) => form.getAll(key).length > 1,
    )
  )
    redirect(usersUrl(filters, "invalid"));
  let result: string;
  try {
    result = await manageUser(getDb(), actor.id, parsed.data);
  } catch (error) {
    if (error instanceof UserManagementError && error.code === "forbidden")
      redirect("/access-denied");
    // Database errors can contain SQL/identity data. Return only an allowlisted message code.
    result = error instanceof UserManagementError ? error.code : "failed";
  }
  for (const path of ["/admin", "/admin/users", "/map", "/pending"])
    revalidatePath(path);
  redirect(usersUrl(filters, result));
}
