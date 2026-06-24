import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const skipAuth = process.env.NEXT_PUBLIC_SKIP_AUTH === 'true'
    const supabase = await createClient()
    const { id } = await params

    let user
    if (skipAuth) {
      // Mock user for development
      user = { id: 'dev-user-id' }
    } else {
      const {
        data: { user: authUser },
      } = await supabase.auth.getUser()

      if (!authUser) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
      }
      user = authUser
    }

    // Delete the API key (RLS will ensure user can only delete their own keys)
    const { error } = await supabase
      .from("api_keys")
      .delete()
      .eq("id", id)
      .eq("user_id", user.id)

    if (error) {
      throw error
    }

    return NextResponse.json({ message: "API key deleted successfully" })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
