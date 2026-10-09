/** Host-owned lifecycle; cadence and execution selection are never browser inputs. */
export interface ManagedObservationController {
  observeManagedCandidates(): Promise<{ scanned: number; issues: string[] }>;
}

export function createDashboardManagedObserver(
  controller: ManagedObservationController,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | null = null;
  let stopped = true;
  let health: { lastTickAt: string | null; scanned: number; issues: string[] } =
    {
      lastTickAt: null,
      scanned: 0,
      issues: [],
    };
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const result = await controller.observeManagedCandidates();
        health = {
          lastTickAt: new Date().toISOString(),
          scanned: result.scanned,
          issues: result.issues.slice(0, 8).map((issue) => issue.slice(0, 256)),
        };
      } catch (error) {
        health = {
          lastTickAt: new Date().toISOString(),
          scanned: 0,
          issues: [
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              256,
            ),
          ],
        };
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(() => {
        void tick();
      }, 1000);
      void tick();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      timer = undefined;
      await inFlight;
    },
    health: () => ({ ...health, issues: [...health.issues] }),
  };
}
