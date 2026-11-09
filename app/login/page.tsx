"use client";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DEFAULT_ALLOWED_DOMAINS } from "@/lib/access";

// Shows the built-in list. If ALLOWED_DOMAINS is set on the server, update lib/access.ts too so this text matches.
const DOMAINS = DEFAULT_ALLOWED_DOMAINS.map((d) => `@${d}`).join(", ");

function LoginInner() {
  const error = useSearchParams().get("error");
  return (
    <div className="login">
      <div className="login-box">
        <h1>Search & traffic dashboard</h1>
        <p style={{ color: "var(--ink-2)" }}>
          Sign in with your company Google account ({DOMAINS}). You&apos;ll see the Search Console and GA4
          properties that account can access. Access is read-only.
        </p>
        {error && (
          <p className="notice error">
            {error === "AccessDenied"
              ? `This Google account isn't allowed. Use a verified company account on ${DOMAINS}, or ask an admin to add your address to ALLOWED_EMAILS.`
              : "Sign-in failed. Check the OAuth client settings and try again."}
          </p>
        )}
        <button className="btn primary" onClick={() => signIn("google", { callbackUrl: "/" })}>
          Sign in with Google
        </button>
      </div>
    </div>
  );
}

export default function Login() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
