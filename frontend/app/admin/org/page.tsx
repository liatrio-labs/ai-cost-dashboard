import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { getCurrentUser, isAdminEmail } from "@/lib/db"
import { OrgAdminClient } from "./OrgAdminClient"

export const dynamic = "force-dynamic"

// Admin-only: departments, teams, people, API keys and the Unassigned queue.
export default async function OrgAdminPage() {
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === "true"

  if (!skipAuth) {
    const cookieStore = await cookies()
    const user = await getCurrentUser(cookieStore)
    if (!user) redirect("/login")
    if (!isAdminEmail(user.email)) redirect("/")
  }

  return <OrgAdminClient />
}
