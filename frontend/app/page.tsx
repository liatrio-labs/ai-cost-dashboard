import { Suspense } from "react"
import { redirect } from "next/navigation"
import { cookies } from "next/headers"
import { getCurrentUser, isAdminEmail } from "@/lib/db"
import { DashboardClient } from "./dashboard/DashboardClient"

export const dynamic = "force-dynamic"

// The homepage IS the dashboard (graphs). Auth-gated; ingest lives under /admin.
export default async function Home() {
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === "true"

  let isAdmin = skipAuth
  if (!skipAuth) {
    const cookieStore = await cookies()
    const user = await getCurrentUser(cookieStore)
    if (!user) {
      redirect("/login")
    }
    isAdmin = await isAdminEmail(user.email)
  }

  // DashboardClient reads its filters from the URL (useSearchParams).
  return (
    <Suspense>
      <DashboardClient isAdmin={isAdmin} />
    </Suspense>
  )
}
