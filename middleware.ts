export { default } from "next-auth/middleware";

// Protect every page except the login screen. API routes check the session themselves
// so they can return JSON errors instead of redirects.
export const config = { matcher: ["/((?!api|login|_next|favicon.ico).*)"] };
