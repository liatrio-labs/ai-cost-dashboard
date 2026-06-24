import { redirect } from "next/navigation"

// The dashboard now lives at the homepage ("/"). Keep this path working by
// redirecting any existing links.
export default function DashboardPage() {
  redirect("/")
}
