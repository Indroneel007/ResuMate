import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Protect the /main route. You can add more protected paths to this array if needed.
  if (pathname.startsWith("/main")) {
    const hasAuth = req.cookies.get("auth")?.value === "1";
    if (!hasAuth) {
      const url = req.nextUrl.clone();
      url.pathname = "/sign-in";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/main/:path*"],
};
