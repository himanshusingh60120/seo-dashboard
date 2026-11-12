/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  experimental: {
    // Lets /api/extension read the chrome-extension folder on Vercel.
    outputFileTracingIncludes: {
      "/api/extension": ["./chrome-extension/**/*"],
      "/api/extension/route": ["./chrome-extension/**/*"],
    },
  },
};
