"use client";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

function LoginInner() {
  const error = useSearchParams().get("error");
  return (
    <div className="login">
      <div className="login-box">
        <h1>Search & traffic dashboard</h1>
        <p style={{ color: "var(--ink-2)" }}>
          Sign in with the Google account that has access to your Search Console and GA4 properties.
          Access is read-only.
        </p>
        {error && (
          <p className="notice error">
            {error === "AccessDenied"
              ? "This Google account isn't on the allowed list. Add it to ALLOWED_EMAILS or use another account."
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
