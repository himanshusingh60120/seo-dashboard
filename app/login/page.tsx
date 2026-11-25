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
          Sign in with your company Google account. You&apos;ll see the Search Console and GA4 properties that account can open.
          Access is read-only.
        </p>
        {error && (
          <p className="notice error">
            {error === "AccessDenied"
              ? "This Google account isn't allowed. Use your company account, or ask an admin to add you in Manage access."
              : "Sign-in failed. Try again, or ask an admin if it keeps happening."}
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
