"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/server/authorization/guards";
import { getDb } from "@/server/db";
import { ApprovalError, approvePendingUser } from "@/server/users/approval";

export async function approveUser(formData: FormData) {
  const actor = await requireAdmin();
  const target = z.uuid().safeParse(formData.get("userId"));
  if (!target.success || formData.getAll("userId").length !== 1) redirect("/admin?result=invalid");
  const requestedPage = Number(formData.get("page") ?? 1);
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  let result: string;
  try {
    result = await approvePendingUser(getDb(), actor.id, target.data);
  } catch (error) {
    if (error instanceof ApprovalError) {
      if (error.code === "forbidden") redirect("/access-denied");
      result = error.code === "not-pending" ? "not-pending" : "invalid";
    } else {
      // Never include SQL, identity data, or connection details in the response.
      result = "error";
    }
  }
  revalidatePath("/admin");
  redirect(`/admin?${new URLSearchParams({ result, page: String(page) })}`);
}
