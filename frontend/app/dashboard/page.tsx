import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { DashboardClient } from "./DashboardClient"

export default async function DashboardPage() {
  // Skip auth check in development mode
  const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === 'true'

  if (!skipAuth) {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      redirect("/login")
    }
  }

  return <DashboardClient />
}
