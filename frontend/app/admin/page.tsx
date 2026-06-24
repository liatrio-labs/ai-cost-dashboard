import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { getCurrentUser, isAdminEmail } from "@/lib/db"
import { AdminClient } from "./AdminClient"

export const dynamic = "force-dynamic"

// Owner-only admin/ingest area: trigger collection + manual entry.
export default async function AdminPage() {
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === "true"

  if (!skipAuth) {
    const cookieStore = await cookies()
    const user = await getCurrentUser(cookieStore)
    if (!user) redirect("/login")
    if (!isAdminEmail(user.email)) redirect("/")
  }

  return <AdminClient />
}
