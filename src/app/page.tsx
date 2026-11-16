// "/" answers 200 and sends the browser on to /library (signed-out visitors
// then go to /sign-in via src/proxy.ts).
//
// It must not be a server redirect. App Runner probes GET / on every new
// instance before routing traffic to it, independent of the configured
// health check, and a 307 there never counts as healthy: deploys of this app
// failed with "Health check failed" until "/" answered 200.
export default function Home() {
  return (
    <>
      <meta httpEquiv="refresh" content="0; url=/library" />
      <main className="flex min-h-screen items-center justify-center p-6">
        <a href="/library" className="underline">
          Open your library
        </a>
      </main>
    </>
  );
}
