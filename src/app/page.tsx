import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/authorization/guards";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.status === "PENDING") redirect("/pending");
  if (user.status === "REJECTED") redirect("/access-denied");
  redirect("/map");
}
