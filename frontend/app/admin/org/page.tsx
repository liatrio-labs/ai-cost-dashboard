import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { getCurrentUser, isAdminEmail } from "@/lib/db"
import { OrgAdminClient } from "./OrgAdminClient"

export const dynamic = "force-dynamic"

// Admin-only: departments, teams, people, identities, API keys, projects,
// import from observed data and the Unassigned queue (issue #7).
export default async function OrgAdminPage() {
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === "true"

  if (!skipAuth) {
    const cookieStore = await cookies()
    const user = await getCurrentUser(cookieStore)
    if (!user) redirect("/login")
    if (!(await isAdminEmail(user.email))) redirect("/")
  }

  return <OrgAdminClient />
}
