"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn, signOut } from "@/auth";

export async function signInWithGoogle() {
  try {
    await signIn("google", { redirectTo: "/map" });
  } catch (error) {
    if (error instanceof AuthError) {
      redirect("/login?error=authentication");
    }
    // Next.js redirects also throw; preserve them so OAuth can continue.
    throw error;
  }
}

export async function signOutOfPortal() {
  await signOut({ redirectTo: "/login" });
}

export async function recheckAccess() {
  redirect("/");
}
